import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  type OpenDialogOptions
} from 'electron'
import { basename, extname, join } from 'path'
import { pathToFileURL } from 'url'
import {
  IPC_CHANNELS,
  SYNC_PROGRESS_CHANNEL,
  type CloudEntry,
  type LibrarySource,
  type SyncProgress,
  type Track
} from '../shared/ipc'
import { resyncBaiduDirectory, syncBaiduDirectory } from './baidu-sync'
import { BaiduService } from './baidu'
import { openLibraryDatabase } from './library-db'
import { LibraryService } from './library'

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

function getLibrary(): LibraryService {
  if (!library) library = new LibraryService(openLibraryDatabase())
  return library
}

function emitSyncProgress(progress: SyncProgress): void {
  mainWindow?.webContents.send(SYNC_PROGRESS_CHANNEL, progress)
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
      sandbox: true
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
  { id: 'quark', name: '夸克网盘', type: 'quark' }
]

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

ipcMain.handle(IPC_CHANNELS.baiduGetStatus, () => baiduService.getStatus())
ipcMain.handle(IPC_CHANNELS.baiduLogin, () => baiduService.login(mainWindow))
ipcMain.handle(IPC_CHANNELS.baiduLogout, () => baiduService.logout())
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

app.whenReady().then(() => {
  getLibrary()

  protocol.handle('app-media', request => {
    const id = new URL(request.url).hostname
    const source = getLibrary().resolveMedia(id)
    if (!source) return new Response('Not found', { status: 404 })
    if (source.kind === 'baidu') return baiduService.stream(source.path, request)

    return net.fetch(pathToFileURL(source.path).toString(), {
      method: request.method,
      headers: request.headers
    })
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
