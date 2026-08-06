import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  SYNC_PROGRESS_CHANNEL,
  type BaiduAuthStatus,
  type BaiduImportResult,
  type CloudEntry,
  type IPCApi,
  type LibraryRootInfo,
  type LibrarySource,
  type PlaylistSummary,
  type SyncProgress,
  type Track,
  type TracksPage
} from '../shared/ipc'

const api: IPCApi = {
  getSources: (): Promise<LibrarySource[]> => ipcRenderer.invoke(IPC_CHANNELS.getSources),
  listTracks: (sourceId: string): Promise<Track[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.listTracks, sourceId),
  listTracksPage: (sourceId: string, offset: number, limit: number, search?: string): Promise<TracksPage> =>
    ipcRenderer.invoke(IPC_CHANNELS.listTracksPage, sourceId, offset, limit, search),
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
    ipcRenderer.invoke(IPC_CHANNELS.playlistRemoveTrack, playlistId, trackId)
}

contextBridge.exposeInMainWorld('api', api)
