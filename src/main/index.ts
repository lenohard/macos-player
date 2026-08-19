import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  type OpenDialogOptions
} from 'electron'
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, extname, join } from 'path'
import { pathToFileURL } from 'url'
import {
  IPC_CHANNELS,
  OPEN_SETTINGS_CHANNEL,
  SYNC_PROGRESS_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  type CloudDownloadRequest,
  type CloudEntry,
  type CloudEntryContextMenuAction,
  type LibrarySource,
  type PlaybackQueueState,
  type PlaybackState,
  type SyncProgress,
  type Track,
  type TrackContextMenuAction,
  type TrackContextMenuRequest,
  type UpdateSnapshot
} from '../shared/ipc'
import { AppUpdater } from './updater'
import { AiService } from './ai'
import { resyncBaiduDirectory, syncBaiduDirectory } from './baidu-sync'
import { BaiduService } from './baidu'
import { openLibraryDatabase } from './library-db'
import { LibraryService } from './library'
import { fetchWithElectronNet, isAsciiHeaderValue } from './media-net'
import { WebDAVService } from './webdav'
import { syncWebDAVDirectory, resyncWebDAVDirectory } from './webdav-sync'
import { startCliServer, stopCliServer, setPlaybackState, ackRemoteCommand } from './cli-server'

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

let mainWindow: BrowserWindow | null = null
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

function installCli(): string {
  const source = app.isPackaged
    ? join(process.resourcesPath, 'corner-cli.mjs')
    : join(app.getAppPath(), 'scripts', 'corner-cli.mjs')
  if (!existsSync(source)) throw new Error('找不到命令行文件，请重新安装 corner。')

  const destination = join(homedir(), '.local', 'bin', 'corner')
  mkdirSync(dirname(destination), { recursive: true })

  try {
    const existing = lstatSync(destination)
    if (!existing.isSymbolicLink()) {
      throw new Error(`安装目标已存在且不是 corner 创建的链接：${destination}`)
    }
    if (readlinkSync(destination) !== source) unlinkSync(destination)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('ENOENT')) {
      if (error instanceof Error && error.message.startsWith('安装目标已存在')) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  if (!existsSync(destination)) symlinkSync(source, destination)
  return destination
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
ipcMain.handle(IPC_CHANNELS.queueLoad, (): PlaybackQueueState | null =>
  getLibrary().loadPlaybackQueue()
)

ipcMain.handle(IPC_CHANNELS.getSources, (): LibrarySource[] => sources)

ipcMain.handle(IPC_CHANNELS.listTracks, (_event, sourceId: string): Track[] =>
  getLibrary().listAllTracks(sourceId)
)

ipcMain.handle(
  IPC_CHANNELS.listTracksPage,
  (_event, sourceId: string, offset: number, limit: number, search?: string) =>
    getLibrary().listTracksPage(sourceId, offset, limit, search)
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
ipcMain.handle(IPC_CHANNELS.cliInstall, () => installCli())
ipcMain.handle(IPC_CHANNELS.playbackPushState, (_event, state: PlaybackState): void => {
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
ipcMain.handle(IPC_CHANNELS.playbackAckCommand, (_event, commandId: string): void => {
  ackRemoteCommand(commandId)
})

ipcMain.handle(IPC_CHANNELS.aiGetConfig, () => aiService.getConfig())
ipcMain.handle(IPC_CHANNELS.aiRevealApiKey, () => aiService.revealApiKey())
ipcMain.handle(IPC_CHANNELS.aiSaveConfig, (_event, config) => aiService.saveConfig(config))
ipcMain.handle(IPC_CHANNELS.aiFetchModels, () => aiService.fetchModels())
ipcMain.handle(IPC_CHANNELS.aiTestConnection, () => aiService.testConnection())

app.whenReady().then(() => {
  getLibrary()
  startCliServer(getLibrary(), () => mainWindow)
  installApplicationMenu()

  protocol.handle('app-media', request => {
    const id = new URL(request.url).hostname
    const source = getLibrary().resolveMedia(id)
    if (!source) return new Response('Not found', { status: 404 })
    if (source.kind === 'baidu') return baiduService.stream(source.path, request)
    if (source.kind === 'webdav') return webdavService.stream(source.path, request)

    const headers = new Headers()
    const range = request.headers.get('Range')
    if (range) headers.set('Range', range)
    return net.fetch(pathToFileURL(source.path).toString(), {
      method: request.method,
      headers
    })
  })

  createWindow()
  appUpdater.scheduleStartupCheck()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopCliServer()
    app.quit()
  }
})

app.on('before-quit', () => {
  stopCliServer()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
