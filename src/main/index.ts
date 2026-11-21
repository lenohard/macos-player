import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  type OpenDialogOptions
} from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import {
  IPC_CHANNELS,
  LIBRARY_CHANGED_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  SONG_INFO_TASKS_CHANGED_CHANNEL,
  SYNC_PROGRESS_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  type CloudDownloadRequest,
  type CloudEntry,
  type CloudEntryContextMenuAction,
  type LibraryExportData,
  type LibraryImportResult,
  type LibrarySource,
  type PlaybackQueueState,
  type PlaybackState,
  type SyncProgress,
  type Track,
  type TrackContextMenuAction,
  type TrackContextMenuRequest,
  type TrackIdentification,
  type UpdateSnapshot
} from '../shared/ipc'
import { AppUpdater } from './updater'
import { AiService } from './ai'
import { resyncBaiduDirectory, syncBaiduDirectory } from './baidu-sync'
import { BaiduService } from './baidu'
import { openLibraryDatabase } from './library-db'
import { LibraryService } from './library'
import { streamTrack } from './track-stream'
import { WebDAVService } from './webdav'
import { syncWebDAVDirectory, resyncWebDAVDirectory } from './webdav-sync'
import { SongInfoService } from './song-info'
import { downloadTrack } from './download'
import { lookupDesktopTrack } from './musicbrainz'
import { setPlaybackState, startCliServer } from './cli-server'
import { DesktopPlaybackCommands, installDesktopCli } from './desktop-cli'

const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'])

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

app.setName('corner')

const desktopProfile = app.getPath('userData')
process.env.CORNER_DATA_DIR = join(desktopProfile, 'local-library')

// One owner per Electron runtime profile.
const ownsProfile = app.requestSingleInstanceLock()
if (!ownsProfile) app.quit()

let mainWindow: BrowserWindow | null = null
const desktopPlayback = new DesktopPlaybackCommands(() => {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  return mainWindow
})
let library: LibraryService | null = null
let lastPlayedTrackId: string | null = null
const baiduService = new BaiduService()
const webdavService = new WebDAVService()
const aiService = new AiService()

function emitUpdateStatus(snapshot: UpdateSnapshot): void {
  mainWindow?.webContents.send(UPDATE_STATUS_CHANNEL, snapshot)
}

const appUpdater = new AppUpdater(emitUpdateStatus)

function getLibrary(): LibraryService {
  if (!library) library = new LibraryService(openLibraryDatabase())
  return library
}

let songInfoService: SongInfoService | null = null

function getSongInfo(): SongInfoService {
  if (!songInfoService) songInfoService = new SongInfoService(getLibrary(), () => aiService.getConfig())
  return songInfoService
}

function emitSyncProgress(progress: SyncProgress): void {
  mainWindow?.webContents.send(SYNC_PROGRESS_CHANNEL, progress)
}

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: '设置…',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send(OPEN_SETTINGS_CHANNEL)
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#15171a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  const sender = mainWindow.webContents
  sender.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) desktopPlayback.reset(sender)
  })
  sender.on('render-process-gone', () => {
    desktopPlayback.reset(sender)
    setPlaybackState(null)
  })
  mainWindow.on('closed', () => {
    desktopPlayback.reset(sender)
    setPlaybackState(null)
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const sources: LibrarySource[] = [
  { id: 'local', name: '本地音乐', type: 'local' },
  { id: 'baidu', name: '百度网盘', type: 'baidu' },
  { id: 'quark', name: 'WebDAV 网盘', type: 'quark' }
]

ipcMain.handle(IPC_CHANNELS.queueSave, (_event, state: PlaybackQueueState): void => {
  getLibrary().savePlaybackQueue(state)
})
ipcMain.handle(IPC_CHANNELS.queueLoad, (): PlaybackQueueState | null => getLibrary().loadPlaybackQueue())

ipcMain.handle(IPC_CHANNELS.getSources, (): LibrarySource[] => sources)

ipcMain.handle(IPC_CHANNELS.listTracks, (_event, sourceId: string): Track[] =>
  getLibrary().listAllTracks(sourceId)
)

ipcMain.handle(
  IPC_CHANNELS.listTracksPage,
  (_event, sourceId: string, offset: number, limit: number, search?: string,
    identified?: 'all' | 'identified' | 'unidentified') =>
    getLibrary().listTracksPage(sourceId, offset, limit, search, identified ?? 'all')
)
ipcMain.handle(IPC_CHANNELS.trackGetDetail, (_event, id: string) => getLibrary().getTrackDetail(id))

ipcMain.handle(IPC_CHANNELS.openLocalTracks, async (): Promise<Track[]> => {
  const options: OpenDialogOptions = {
    title: '选择音乐',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '音频文件', extensions: [...AUDIO_EXTENSIONS].map(extension => extension.slice(1)) }
    ]
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled) return []

  return result.filePaths
    .filter(filePath => AUDIO_EXTENSIONS.has(extname(filePath).toLowerCase()))
    .map(filePath => getLibrary().upsertLocalTrack(filePath))
})

ipcMain.handle(
  IPC_CHANNELS.cloudEntryContextMenu,
  (event, _request: CloudDownloadRequest) =>
    new Promise<CloudEntryContextMenuAction | null>(resolve => {
      let selected: CloudEntryContextMenuAction | null = null
      Menu.buildFromTemplate([
        { label: '直接下载到本机', click: () => { selected = { type: 'download' } } }
      ]).popup({
        window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
        callback: () => resolve(selected)
      })
    })
)

ipcMain.handle(IPC_CHANNELS.cloudDownload, async (event, request: CloudDownloadRequest): Promise<string | null> => {
  if (request.entry.isDirectory) throw new Error('文件夹不能下载。')

  const options: Electron.SaveDialogOptions = {
    title: '下载文件',
    defaultPath: basename(request.entry.name) || '下载文件',
    buttonLabel: '保存'
  }
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = owner
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null

  if (request.sourceId === 'baidu') {
    await baiduService.download(request.entry.path, result.filePath)
  } else if (request.sourceId === 'quark') {
    await webdavService.download(request.entry.path, result.filePath)
  } else {
    throw new Error('不支持的云盘来源。')
  }
  return result.filePath
})

ipcMain.handle(IPC_CHANNELS.webdavGetStatus, async () => {
  try { return await webdavService.testConnection() } catch { return webdavService.getStatus() }
})
ipcMain.handle(IPC_CHANNELS.webdavDisconnect, () => webdavService.disconnect())

ipcMain.handle(IPC_CHANNELS.webdavSaveConfig, async (_event, config) => {
  webdavService.saveConfig(config)
  try { return await webdavService.testConnection() } catch { return webdavService.getStatus() }
})
ipcMain.handle(IPC_CHANNELS.webdavListDirectory, (_event, path: string) => webdavService.listDirectory(path))
ipcMain.handle(IPC_CHANNELS.webdavCreateTrack, (_event, entry: CloudEntry): Track => {
  if (entry.isDirectory) throw new Error('文件夹不能播放。')
  const { trackId } = getLibrary().upsertCloudTrack('quark', entry, Date.now()); const row = getLibrary().getTrackRow(trackId)
  if (!row) throw new Error('无法创建播放条目。')
  return { id: row.id, title: row.title, artist: row.artist, durationSec: row.duration_sec, sourceId: row.source_id, playbackUrl: `app-media://${row.id}/audio` }
})
ipcMain.handle(IPC_CHANNELS.webdavImportDirectory, (_event, root: string, name: string) => syncWebDAVDirectory(webdavService,getLibrary(),root,name,emitSyncProgress))
ipcMain.handle(IPC_CHANNELS.webdavResyncDirectory, (_event, root: string) => resyncWebDAVDirectory(webdavService,getLibrary(),root,emitSyncProgress))
ipcMain.handle(IPC_CHANNELS.webdavListRoots, () => getLibrary().listLibraryRoots('quark').map(root => ({id:root.id,sourceId:root.source_id,rootPath:root.root_path,playlistId:root.playlist_id,lastSyncAt:root.last_sync_at,lastSyncStatus:root.last_sync_status})))


ipcMain.handle(IPC_CHANNELS.baiduLogin, () => baiduService.login(mainWindow))
ipcMain.handle(IPC_CHANNELS.baiduLogout, () => baiduService.logout())
ipcMain.handle(IPC_CHANNELS.baiduGetStatus, () => baiduService.getStatus())
ipcMain.handle(
  IPC_CHANNELS.baiduListDirectory,
  (_event, path: string) => baiduService.listDirectory(path)
)
ipcMain.handle(IPC_CHANNELS.baiduCreateTrack, (_event, entry: CloudEntry): Track => {
  if (entry.isDirectory) throw new Error('文件夹不能播放。')
  const syncToken = Date.now()
  const { trackId } = getLibrary().upsertBaiduTrack(entry, syncToken)
  const row = getLibrary().getTrackRow(trackId)
  if (!row) throw new Error('无法创建播放条目。')
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    durationSec: row.duration_sec,
    sourceId: row.source_id,
    playbackUrl: `app-media://${row.id}/audio`
  }
})

ipcMain.handle(
  IPC_CHANNELS.baiduImportDirectory,
  async (_event, rootPath: string, playlistName: string) =>
    syncBaiduDirectory(baiduService, getLibrary(), rootPath, playlistName, emitSyncProgress)
)

ipcMain.handle(
  IPC_CHANNELS.baiduResyncDirectory,
  async (_event, rootPath: string) =>
    resyncBaiduDirectory(baiduService, getLibrary(), rootPath, emitSyncProgress)
)

ipcMain.handle(IPC_CHANNELS.baiduListRoots, () =>
  getLibrary().listLibraryRoots('baidu').map(root => ({
    id: root.id,
    sourceId: root.source_id,
    rootPath: root.root_path,
    playlistId: root.playlist_id,
    lastSyncAt: root.last_sync_at,
    lastSyncStatus: root.last_sync_status
  }))
)

ipcMain.handle(IPC_CHANNELS.playlistList, () => getLibrary().listPlaylists())
ipcMain.handle(IPC_CHANNELS.playlistCreate, (_event, name: string) => getLibrary().createPlaylist(name))
ipcMain.handle(IPC_CHANNELS.playlistRename, (_event, id: string, name: string) =>
  getLibrary().renamePlaylist(id, name)
)
ipcMain.handle(IPC_CHANNELS.playlistDelete, (_event, id: string) => {
  getLibrary().deletePlaylist(id)
})
ipcMain.handle(IPC_CHANNELS.playlistListTracks, (_event, playlistId: string) =>
  getLibrary().listPlaylistTracks(playlistId)
)
ipcMain.handle(IPC_CHANNELS.playlistAddTrack, (_event, playlistId: string, trackId: string) => {
  getLibrary().addTrackToPlaylist(playlistId, trackId)
})
ipcMain.handle(IPC_CHANNELS.playlistRemoveTrack, (_event, playlistId: string, trackId: string) => {
  getLibrary().removeTrackFromPlaylist(playlistId, trackId)
})

ipcMain.handle(IPC_CHANNELS.favoritesList, () => getLibrary().listFavoriteTracks())
ipcMain.handle(IPC_CHANNELS.favoritesAdd, (_event, track: string | Track) => {
  getLibrary().addFavorite(typeof track === 'string' ? track : track.id)
})
ipcMain.handle(IPC_CHANNELS.favoritesRemove, (_event, trackId: string) => {
  getLibrary().removeFavorite(trackId)
})

ipcMain.handle(IPC_CHANNELS.libraryExport, async (event): Promise<string | null> => {
  const options: Electron.SaveDialogOptions = {
    title: '导出歌单与收藏',
    defaultPath: `corner-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
    buttonLabel: '导出'
  }
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = owner
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  const data = getLibrary().exportUserData()
  writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8')
  return result.filePath
})

ipcMain.handle(IPC_CHANNELS.libraryImport, async (event): Promise<LibraryImportResult | null> => {
  const options: OpenDialogOptions = {
    title: '导入备份',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  const data = JSON.parse(readFileSync(result.filePaths[0], 'utf8')) as LibraryExportData
  return getLibrary().importUserData(data)
})

ipcMain.handle(IPC_CHANNELS.trackContextMenu, (event, request: TrackContextMenuRequest) =>
  new Promise<TrackContextMenuAction | null>(resolve => {
    let selected: TrackContextMenuAction | null = null
    const choose = (action: TrackContextMenuAction) => (): void => { selected = action }
    const playlistItems: Electron.MenuItemConstructorOptions[] = request.playlists.length > 0
      ? request.playlists.map(playlist => ({
          label: playlist.name,
          click: choose({ type: 'addToPlaylist', playlistId: playlist.id })
        }))
      : [{ label: '没有歌单', enabled: false }]
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: '播放', click: choose({ type: 'play' }) },
      { label: '下一首播放', click: choose({ type: 'playNext' }) },
      { label: '添加到播放列表', click: choose({ type: 'addToQueue' }) },
      { label: '添加到歌单', submenu: playlistItems },
      { type: 'separator' },
      { label: '显示详情', click: choose({ type: 'showDetails' }) }
    ]
    if (request.canRemoveFromQueue || request.canRemoveFromPlaylist) {
      template.push({ type: 'separator' })
      if (request.canRemoveFromQueue) {
        template.push({ label: '从播放列表移除', click: choose({ type: 'removeFromQueue' }) })
      }
      if (request.canRemoveFromPlaylist) {
        template.push({ label: '从此歌单移除', click: choose({ type: 'removeFromPlaylist' }) })
      }
    }
    Menu.buildFromTemplate(template).popup({
      window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
      callback: () => resolve(selected)
    })
  })
)

ipcMain.handle(IPC_CHANNELS.updateGetStatus, () => appUpdater.getSnapshot())
ipcMain.handle(IPC_CHANNELS.updateCheck, () => appUpdater.checkForUpdates())
ipcMain.handle(IPC_CHANNELS.updateDownload, () => appUpdater.downloadUpdate())
ipcMain.handle(IPC_CHANNELS.updateInstall, () => appUpdater.quitAndInstall())
ipcMain.handle(IPC_CHANNELS.cliInstall, () => installDesktopCli())
ipcMain.handle(IPC_CHANNELS.playbackRemoteReady, event => {
  if (event.sender === mainWindow?.webContents) desktopPlayback.markReady(event.sender)
})
ipcMain.handle(IPC_CHANNELS.playbackAckCommand, (event, commandId: string) => {
  desktopPlayback.acknowledge(event.sender, commandId)
})
ipcMain.handle(IPC_CHANNELS.playbackPushState, (event, state: PlaybackState): void => {
  if (event.sender !== mainWindow?.webContents) return
  setPlaybackState(state)
  const trackId = state.currentTrack?.id ?? null
  if (trackId && trackId !== lastPlayedTrackId && state.isPlaying) {
    lastPlayedTrackId = trackId
    try {
      getLibrary().recordPlay(trackId)
    } catch {
      // 历史记录失败不影响播放状态上报
    }
  }
})

ipcMain.handle(IPC_CHANNELS.aiGetConfig, () => aiService.getConfig())

ipcMain.handle(IPC_CHANNELS.aiSaveConfig, (_event, config) => aiService.saveConfig(config))
ipcMain.handle(IPC_CHANNELS.aiFetchModels, (_event, piWebUrl?: string) => aiService.fetchModels(piWebUrl))
ipcMain.handle(IPC_CHANNELS.aiTestConnection, () => aiService.testConnection())
ipcMain.handle(IPC_CHANNELS.trackDownload, (_event, trackId: string, dest?: string) =>
  downloadTrack({ library: getLibrary(), baidu: baiduService, webdav: webdavService }, trackId, dest))
ipcMain.handle(IPC_CHANNELS.songInfoGet, (_event, identifier: string) => getSongInfo().get(identifier))
ipcMain.handle(IPC_CHANNELS.songInfoLookup, (_event, trackId: string): { requestId: string } =>
  getSongInfo().lookupTrack(trackId)
)
ipcMain.handle(IPC_CHANNELS.songInfoListTasks, () => getSongInfo().listTasks())
ipcMain.handle(IPC_CHANNELS.songInfoGetTaskResult, (_event, id: string) => getSongInfo().getTaskResult(id))
ipcMain.handle(IPC_CHANNELS.songInfoCancelTask, (_event, id: string) => getSongInfo().cancelTask(id))
ipcMain.handle(IPC_CHANNELS.songInfoRetryTask, (_event, id: string) => getSongInfo().retryTask(id))
ipcMain.handle(IPC_CHANNELS.songInfoDeleteTask, (_event, id: string) => getSongInfo().deleteTask(id))

// MusicBrainz 识别：候选检索不写库，用户确认后由 trackApplyIdentification 写入。
ipcMain.handle(IPC_CHANNELS.musicBrainzLookup, async (_event, trackId: string) => {
  const track = getLibrary().getTrackDetail(trackId)
  if (!track) throw new Error('曲目不存在。')
  return lookupDesktopTrack(track)
})
ipcMain.handle(IPC_CHANNELS.trackApplyIdentification, (_event, trackId: string, identification: TrackIdentification) =>
  getLibrary().applyIdentification(trackId, identification))

app.whenReady().then(() => {
  if (!ownsProfile) return
  const desktopLibrary = getLibrary()
  try {
    app.once('before-quit', startCliServer({
      library: desktopLibrary,
      songInfo: getSongInfo(),
      endpointDir: join(desktopProfile, 'desktop-cli'),
      baidu: baiduService,
      webdav: webdavService,
      desktop: {
        sendCommand: command => desktopPlayback.send(command),
        async resyncLibrary(rootPath) {
          const normalized = rootPath.replace(/\/+$/, '') || '/'
          if (desktopLibrary.listLibraryRoots('baidu').some(root => root.root_path === normalized)) {
            return resyncBaiduDirectory(baiduService, desktopLibrary, normalized, emitSyncProgress)
          }
          if (desktopLibrary.listLibraryRoots('quark').some(root => root.root_path === normalized)) {
            return resyncWebDAVDirectory(webdavService, desktopLibrary, normalized, emitSyncProgress)
          }
          throw new Error('该目录尚未导入，请先执行导入。')
        },
        onLibraryChanged: () => {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send(LIBRARY_CHANGED_CHANNEL)
          }
        }
      }
    }))
  } catch (error) {
    console.error('[CLI] desktop listener failed:', error)
  }
  // 检索任务列表变化推送给渲染进程（进度事件可合并，不推增量文本）
  getSongInfo().onTasksChanged(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SONG_INFO_TASKS_CHANGED_CHANNEL)
    }
  })
  installApplicationMenu()
  protocol.handle('app-media', request =>
    streamTrack(getLibrary(), baiduService, webdavService, new URL(request.url).hostname, request)
  )

  createWindow()
  appUpdater.scheduleStartupCheck()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function showWindow(): void {
  if (!ownsProfile || !app.isReady()) return
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}
app.on('activate', showWindow)
app.on('second-instance', showWindow)
