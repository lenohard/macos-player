/** Shared main/preload/renderer contracts. */

export const IPC_CHANNELS = {
  getSources: 'library:getSources',
  queueSave: 'queue:save',
  queueLoad: 'queue:load',
  listTracks: 'library:listTracks',
  listTracksPage: 'library:listTracksPage',
  trackGetDetail: 'track:getDetail',
  openLocalTracks: 'library:openLocalTracks',
  baiduGetStatus: 'baidu:getStatus',
  baiduLogin: 'baidu:login',
  baiduLogout: 'baidu:logout',
  baiduListDirectory: 'baidu:listDirectory',
  baiduCreateTrack: 'baidu:createTrack',
  baiduImportDirectory: 'baidu:importDirectory',
  baiduResyncDirectory: 'baidu:resyncDirectory',
  baiduListRoots: 'baidu:listRoots',
  webdavGetStatus: 'webdav:getStatus',
  webdavDisconnect: 'webdav:disconnect',
  webdavSaveConfig: 'webdav:saveConfig',
  webdavListDirectory: 'webdav:listDirectory',
  webdavCreateTrack: 'webdav:createTrack',
  webdavImportDirectory: 'webdav:importDirectory',
  webdavResyncDirectory: 'webdav:resyncDirectory',
  webdavListRoots: 'webdav:listRoots',
  playlistList: 'playlist:list',
  playlistCreate: 'playlist:create',
  playlistRename: 'playlist:rename',
  playlistDelete: 'playlist:delete',
  playlistListTracks: 'playlist:listTracks',
  playlistAddTrack: 'playlist:addTrack',
  playlistRemoveTrack: 'playlist:removeTrack',
  updateGetStatus: 'update:getStatus',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install'
} as const

export const SYNC_PROGRESS_CHANNEL = 'library:syncProgress'
export const UPDATE_STATUS_CHANNEL = 'update:status'

export interface Track {
  id: string
  title: string
  artist: string | null
  durationSec: number | null
  sourceId: string
  playbackUrl: string
}

export interface TrackDetail extends Track {
  path: string
  size: number
  modifiedAt: number
  md5: string | null
  remoteId: string | null
}

export type RepeatMode = 'off' | 'all' | 'one'

export interface PlaybackQueueState {
  tracks: Track[]
  currentIndex: number
  shuffle: boolean
  repeatMode: RepeatMode
  playOrder: number[]
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

export interface WebDAVConfig {
  url: string
  username: string
  password: string
}

export interface WebDAVStatus {
  configured: boolean
  connected: boolean
  url: string
  username: string
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

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateReleaseInfo {
  version: string
  releaseDate: string
  releaseNotes: string
}

export interface UpdateSnapshot {
  appVersion: string
  enabled: boolean
  status: UpdateStatus
  error: string | null
  progress: number | null
  info: UpdateReleaseInfo | null
}

export interface IPCApi {
  queueSave(state: PlaybackQueueState): Promise<void>
  queueLoad(): Promise<PlaybackQueueState | null>
  getSources(): Promise<LibrarySource[]>
  listTracks(sourceId: string): Promise<Track[]>
  listTracksPage(sourceId: string, offset: number, limit: number, search?: string): Promise<TracksPage>
  trackGetDetail(id: string): Promise<TrackDetail | null>
  openLocalTracks(): Promise<Track[]>
  baiduGetStatus(): Promise<BaiduAuthStatus>
  baiduLogin(): Promise<BaiduAuthStatus>
  baiduLogout(): Promise<BaiduAuthStatus>
  baiduListDirectory(path: string): Promise<CloudEntry[]>
  baiduCreateTrack(entry: CloudEntry): Promise<Track>
  baiduImportDirectory(rootPath: string, playlistName: string): Promise<BaiduImportResult>
  baiduResyncDirectory(rootPath: string): Promise<BaiduImportResult>
  baiduListRoots(): Promise<LibraryRootInfo[]>
  webdavGetStatus(): Promise<WebDAVStatus>
  webdavDisconnect(): Promise<WebDAVStatus>
  webdavSaveConfig(config: WebDAVConfig): Promise<WebDAVStatus>
  webdavListDirectory(path: string): Promise<CloudEntry[]>
  webdavCreateTrack(entry: CloudEntry): Promise<Track>
  webdavImportDirectory(rootPath: string, playlistName: string): Promise<BaiduImportResult>
  webdavResyncDirectory(rootPath: string): Promise<BaiduImportResult>
  webdavListRoots(): Promise<LibraryRootInfo[]>
  onSyncProgress(listener: (progress: SyncProgress) => void): () => void
  playlistList(): Promise<PlaylistSummary[]>
  playlistCreate(name: string): Promise<PlaylistSummary>
  playlistRename(id: string, name: string): Promise<PlaylistSummary>
  playlistDelete(id: string): Promise<void>
  playlistListTracks(playlistId: string): Promise<Track[]>
  playlistAddTrack(playlistId: string, trackId: string): Promise<void>
  playlistRemoveTrack(playlistId: string, trackId: string): Promise<void>
  updateGetStatus(): Promise<UpdateSnapshot>
  updateCheck(): Promise<UpdateSnapshot>
  updateDownload(): Promise<UpdateSnapshot>
  updateInstall(): Promise<boolean>
  onUpdateStatus(listener: (snapshot: UpdateSnapshot) => void): () => void
}

declare global {
  interface Window {
    api: IPCApi
  }
}
