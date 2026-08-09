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
import { basename, extname, join } from 'path'
import { pathToFileURL } from 'url'
import {
  IPC_CHANNELS,
  OPEN_SETTINGS_CHANNEL,
  SYNC_PROGRESS_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  type CloudEntry,
  type LibrarySource,
  type PlaybackQueueState,
  type SyncProgress,
  type Track,
  type TrackContextMenuAction,
  type TrackContextMenuRequest,
  type UpdateSnapshot
} from '../shared/ipc'
import { AppUpdater } from './updater'
import { resyncBaiduDirectory, syncBaiduDirectory } from './baidu-sync'
import { BaiduService } from './baidu'
import { openLibraryDatabase } from './library-db'
import { LibraryService } from './library'
import { fetchWithElectronNet, isAsciiHeaderValue } from './media-net'
import { WebDAVService } from './webdav'
import { syncWebDAVDirectory, resyncWebDAVDirectory } from './webdav-sync'

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
const baiduService = new BaiduService()
const webdavService = new WebDAVService()

function emitUpdateStatus(snapshot: UpdateSnapshot): void {
  mainWindow?.webContents.send(UPDATE_STATUS_CHANNEL, snapshot)
}

const appUpdater = new AppUpdater(emitUpdateStatus)

function getLibrary(): LibraryService {
  if (!library) library = new LibraryService(openLibraryDatabase())
  return library
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

ipcMain.handle(IPC_CHANNELS.listTracks, (_event, sourceId: string): Track[] => {
  const page = getLibrary().listTracksPage(sourceId, 0, 10_000)
  return page.tracks
})

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
  const id = getLibrary().upsertCloudTrack('quark', entry, Date.now()); const row = getLibrary().getTrackRow(id)
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
  const trackId = getLibrary().upsertBaiduTrack(entry, syncToken)
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

app.whenReady().then(() => {
  getLibrary()
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
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
