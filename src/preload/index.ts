import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  OPEN_SETTINGS_CHANNEL,
  SYNC_PROGRESS_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  type AiConfig,
  type AiModelInfo,
  type AiTestResult,
  type BaiduAuthStatus,
  type BaiduImportResult,
  type CloudEntry,
  type IPCApi,
  type LibraryRootInfo,
  type LibrarySource,
  type PlaybackQueueState,
  type PlaylistSummary,
  type SyncProgress,
  type Track,
  type TrackContextMenuAction,
  type TrackContextMenuRequest,
  type TrackDetail,
  type TracksPage,
  type UpdateSnapshot,
  type WebDAVConfig,
  type WebDAVStatus
} from '../shared/ipc'

const api: IPCApi = {
  queueSave: (state: PlaybackQueueState): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.queueSave, state),
  queueLoad: (): Promise<PlaybackQueueState | null> => ipcRenderer.invoke(IPC_CHANNELS.queueLoad),
  getSources: (): Promise<LibrarySource[]> => ipcRenderer.invoke(IPC_CHANNELS.getSources),
  listTracks: (sourceId: string): Promise<Track[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.listTracks, sourceId),
  listTracksPage: (sourceId: string, offset: number, limit: number, search?: string): Promise<TracksPage> =>
    ipcRenderer.invoke(IPC_CHANNELS.listTracksPage, sourceId, offset, limit, search),
  trackGetDetail: (id: string): Promise<TrackDetail | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.trackGetDetail, id),
  openLocalTracks: (): Promise<Track[]> => ipcRenderer.invoke(IPC_CHANNELS.openLocalTracks),
  baiduGetStatus: (): Promise<BaiduAuthStatus> => ipcRenderer.invoke(IPC_CHANNELS.baiduGetStatus),
  baiduLogin: (): Promise<BaiduAuthStatus> => ipcRenderer.invoke(IPC_CHANNELS.baiduLogin),
  baiduLogout: (): Promise<BaiduAuthStatus> => ipcRenderer.invoke(IPC_CHANNELS.baiduLogout),
  baiduListDirectory: (path: string): Promise<CloudEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.baiduListDirectory, path),
  baiduCreateTrack: (entry: CloudEntry): Promise<Track> =>
    ipcRenderer.invoke(IPC_CHANNELS.baiduCreateTrack, entry),
  baiduImportDirectory: (rootPath: string, playlistName: string): Promise<BaiduImportResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.baiduImportDirectory, rootPath, playlistName),
  baiduResyncDirectory: (rootPath: string): Promise<BaiduImportResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.baiduResyncDirectory, rootPath),
  baiduListRoots: (): Promise<LibraryRootInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.baiduListRoots),
  webdavGetStatus: (): Promise<WebDAVStatus> => ipcRenderer.invoke(IPC_CHANNELS.webdavGetStatus),
  webdavDisconnect: (): Promise<WebDAVStatus> => ipcRenderer.invoke(IPC_CHANNELS.webdavDisconnect),
  webdavSaveConfig: (config: WebDAVConfig): Promise<WebDAVStatus> => ipcRenderer.invoke(IPC_CHANNELS.webdavSaveConfig, config),
  webdavListDirectory: (path: string): Promise<CloudEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.webdavListDirectory, path),
  webdavCreateTrack: (entry: CloudEntry): Promise<Track> => ipcRenderer.invoke(IPC_CHANNELS.webdavCreateTrack, entry),
  webdavImportDirectory: (root: string, name: string): Promise<BaiduImportResult> => ipcRenderer.invoke(IPC_CHANNELS.webdavImportDirectory, root, name),
  webdavResyncDirectory: (root: string): Promise<BaiduImportResult> => ipcRenderer.invoke(IPC_CHANNELS.webdavResyncDirectory, root),
  webdavListRoots: (): Promise<LibraryRootInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.webdavListRoots),
  onSyncProgress: (listener: (progress: SyncProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: SyncProgress) => listener(progress)
    ipcRenderer.on(SYNC_PROGRESS_CHANNEL, handler)
    return () => ipcRenderer.removeListener(SYNC_PROGRESS_CHANNEL, handler)
  },
  playlistList: (): Promise<PlaylistSummary[]> => ipcRenderer.invoke(IPC_CHANNELS.playlistList),
  playlistCreate: (name: string): Promise<PlaylistSummary> =>
    ipcRenderer.invoke(IPC_CHANNELS.playlistCreate, name),
  playlistRename: (id: string, name: string): Promise<PlaylistSummary> =>
    ipcRenderer.invoke(IPC_CHANNELS.playlistRename, id, name),
  playlistDelete: (id: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.playlistDelete, id),
  playlistListTracks: (playlistId: string): Promise<Track[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.playlistListTracks, playlistId),
  playlistAddTrack: (playlistId: string, trackId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.playlistAddTrack, playlistId, trackId),
  playlistRemoveTrack: (playlistId: string, trackId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.playlistRemoveTrack, playlistId, trackId),
  updateGetStatus: (): Promise<UpdateSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.updateGetStatus),
  updateCheck: (): Promise<UpdateSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
  updateDownload: (): Promise<UpdateSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.updateDownload),
  updateInstall: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
  trackContextMenu: (request: TrackContextMenuRequest): Promise<TrackContextMenuAction | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.trackContextMenu, request),
  onOpenSettings: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on(OPEN_SETTINGS_CHANNEL, handler)
    return () => ipcRenderer.removeListener(OPEN_SETTINGS_CHANNEL, handler)
  },
  onUpdateStatus: (listener: (snapshot: UpdateSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: UpdateSnapshot) => listener(snapshot)
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, handler)
    return () => ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, handler)
  },
  aiGetConfig: (): Promise<AiConfig> => ipcRenderer.invoke(IPC_CHANNELS.aiGetConfig),
  aiRevealApiKey: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.aiRevealApiKey),
  aiSaveConfig: (config: AiConfig): Promise<AiConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.aiSaveConfig, config),
  aiFetchModels: (): Promise<AiModelInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.aiFetchModels),
  aiTestConnection: (): Promise<AiTestResult> => ipcRenderer.invoke(IPC_CHANNELS.aiTestConnection)
}

contextBridge.exposeInMainWorld('api', api)
