/** Shared main/preload/renderer contracts. */

export const IPC_CHANNELS = {
  getSources: 'library:getSources',
  listTracks: 'library:listTracks',
  listTracksPage: 'library:listTracksPage',
  openLocalTracks: 'library:openLocalTracks',
  baiduGetStatus: 'baidu:getStatus',
  baiduLogin: 'baidu:login',
  baiduLogout: 'baidu:logout',
  baiduListDirectory: 'baidu:listDirectory',
  baiduCreateTrack: 'baidu:createTrack',
  baiduImportDirectory: 'baidu:importDirectory',
  baiduResyncDirectory: 'baidu:resyncDirectory',
  baiduListRoots: 'baidu:listRoots',
  playlistList: 'playlist:list',
  playlistCreate: 'playlist:create',
  playlistRename: 'playlist:rename',
  playlistDelete: 'playlist:delete',
  playlistListTracks: 'playlist:listTracks',
  playlistAddTrack: 'playlist:addTrack',
  playlistRemoveTrack: 'playlist:removeTrack'
} as const

export const SYNC_PROGRESS_CHANNEL = 'library:syncProgress'

export interface Track {
  id: string
  title: string
  artist: string | null
  durationSec: number | null
  sourceId: string
  playbackUrl: string
}

export interface TracksPage {
  tracks: Track[]
  total: number
  offset: number
  limit: number
}

export interface LibrarySource {
  id: string
  name: string
  type: 'local' | 'quark' | 'baidu'
}

export interface BaiduAuthStatus {
  configured: boolean
  connected: boolean
  expiresAt: number | null
}

export interface CloudEntry {
  id: string
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
}

export interface PlaylistSummary {
  id: string
  name: string
  trackCount: number
  updatedAt: number
}

export interface LibraryRootInfo {
  id: string
  sourceId: string
  rootPath: string
  playlistId: string | null
  lastSyncAt: number | null
  lastSyncStatus: string | null
}

export interface BaiduImportResult {
  rootPath: string
  playlistId: string
  scanned: number
  added: number
  updated: number
  removed: number
}

export interface SyncProgress {
  phase: 'scanning' | 'done' | 'error'
  currentPath: string
  directoriesDone: number
  tracksUpserted: number
  message?: string
}

export interface IPCApi {
  getSources(): Promise<LibrarySource[]>
  listTracks(sourceId: string): Promise<Track[]>
  listTracksPage(sourceId: string, offset: number, limit: number, search?: string): Promise<TracksPage>
  openLocalTracks(): Promise<Track[]>
  baiduGetStatus(): Promise<BaiduAuthStatus>
  baiduLogin(): Promise<BaiduAuthStatus>
  baiduLogout(): Promise<BaiduAuthStatus>
  baiduListDirectory(path: string): Promise<CloudEntry[]>
  baiduCreateTrack(entry: CloudEntry): Promise<Track>
  baiduImportDirectory(rootPath: string, playlistName: string): Promise<BaiduImportResult>
  baiduResyncDirectory(rootPath: string): Promise<BaiduImportResult>
  baiduListRoots(): Promise<LibraryRootInfo[]>
  onSyncProgress(listener: (progress: SyncProgress) => void): () => void
  playlistList(): Promise<PlaylistSummary[]>
  playlistCreate(name: string): Promise<PlaylistSummary>
  playlistRename(id: string, name: string): Promise<PlaylistSummary>
  playlistDelete(id: string): Promise<void>
  playlistListTracks(playlistId: string): Promise<Track[]>
  playlistAddTrack(playlistId: string, trackId: string): Promise<void>
  playlistRemoveTrack(playlistId: string, trackId: string): Promise<void>
}

declare global {
  interface Window {
    api: IPCApi
  }
}
