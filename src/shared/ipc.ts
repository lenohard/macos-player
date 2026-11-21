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
  cloudEntryContextMenu: 'cloud:entryContextMenu',
  cloudDownload: 'cloud:download',
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
  favoritesList: 'favorites:list',
  favoritesAdd: 'favorites:add',
  favoritesRemove: 'favorites:remove',
  updateGetStatus: 'update:getStatus',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  cliInstall: 'cli:install',
  libraryExport: 'library:export',
  libraryImport: 'library:import',
  playbackPushState: 'playback:pushState',
  playbackAckCommand: 'playback:ackCommand',
  playbackRemoteReady: 'playback:remoteReady',
  trackContextMenu: 'track:contextMenu',
  songInfoGet: 'songInfo:get',
  songInfoLookup: 'songInfo:lookup',
  songInfoListTasks: 'songInfo:listTasks',
  songInfoGetTaskResult: 'songInfo:getTaskResult',
  songInfoCancelTask: 'songInfo:cancelTask',
  songInfoRetryTask: 'songInfo:retryTask',
  songInfoDeleteTask: 'songInfo:deleteTask',
  musicBrainzLookup: 'musicBrainz:lookup',
  trackApplyIdentification: 'track:applyIdentification',
  trackDownload: 'track:download',
  aiGetConfig: 'ai:getConfig',

  aiSaveConfig: 'ai:saveConfig',
  aiFetchModels: 'ai:fetchModels',
  aiTestConnection: 'ai:testConnection'
} as const

export const PLAYBACK_REMOTE_COMMAND_CHANNEL = 'playback:remoteCommand'
export const OPEN_SETTINGS_CHANNEL = 'app:openSettings'
export const SYNC_PROGRESS_CHANNEL = 'library:syncProgress'
export const SONG_INFO_TASKS_CHANGED_CHANNEL = 'songInfo:tasksChanged'
export const LIBRARY_CHANGED_CHANNEL = 'library:changed'
export const UPDATE_STATUS_CHANNEL = 'update:status'

export type RemoteCommand = (
  | { action: 'play'; tracks: Track[] }
  | { action: 'playSingle'; track: Track }
  | { action: 'next' }
  | { action: 'prev' }
  | { action: 'togglePlay' }
  | { action: 'shuffle' }
  | { action: 'repeat' }
  | { action: 'setVolume'; volume: number }
  | { action: 'seek'; positionSec: number }
) & { id?: string }

export interface PlaybackState {
  isPlaying: boolean
  currentTrack: Track | null
  queueLength: number
  currentIndex: number
  shuffle: boolean
  repeatMode: RepeatMode
  volume: number
  positionSec: number
  durationSec: number
}

export interface Track {
  id: string
  title: string
  artist: string | null
  durationSec: number | null
  sourceId: string
  playbackUrl: string
  /** 是否已完成 MusicBrainz 识别；未查询该列的列表返回 undefined。 */
  identified?: boolean
}

export interface TrackDetail extends Track {
  path: string
  size: number
  modifiedAt: number
  md5: string | null
  remoteId: string | null
  album: string | null
  /** 专辑封面地址（Cover Art Archive）。 */
  coverUrl: string | null
  mbRecordingId: string | null
  mbReleaseId: string | null
  mbArtistId: string | null
  mbScore: number | null
  /** 识别完成时间（epoch ms）；null = 未识别。 */
  identifiedAt: number | null
}

/** MusicBrainz 单曲候选（由主进程 musicbrainz.ts 生成）。 */
export interface MusicBrainzCandidate {
  id: string
  title: string
  artist: string | null
  artistId: string | null
  durationSec: number | null
  firstReleaseDate: string | null
  score: number
  album: string | null
  releaseId: string | null
  coverUrl: string | null
}

export interface MusicBrainzLookupResult {
  /** 本地文件时长（秒）；探测失败时为 null。 */
  localDurationSec: number | null
  candidates: MusicBrainzCandidate[]
}

/** 保存识别结果时写入曲目的字段。 */
export interface TrackIdentification {
  recordingId: string
  releaseId: string | null
  artistId: string | null
  album: string | null
  coverUrl: string | null
  score: number | null
  title: string | null
  artist: string | null
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

export type CloudSourceId = 'baidu' | 'quark'

export interface CloudDownloadRequest {
  sourceId: CloudSourceId
  entry: CloudEntry
}

export type CloudEntryContextMenuAction = { type: 'download' }

/** 备份文件中的曲目引用：跨机器稳定身份 = (sourceId, path)。 */
export interface ExportedTrackRef {
  sourceId: string
  path: string
  title: string
  artist: string | null
}

export interface LibraryExportData {
  app: 'corner'
  version: 1
  exportedAt: number
  playlists: Array<{ name: string; tracks: ExportedTrackRef[] }>
  favorites: ExportedTrackRef[]
}

export interface LibraryImportResult {
  playlistsCreated: number
  playlistsMatched: number
  tracksAdded: number
  tracksMissing: number
  favoritesAdded: number
  favoritesExisting: number
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

export interface SyncTrackDetail {
  id: string
  title: string
  artist: string | null
  path: string
  /** 更新时若文件路径发生变化，记录旧路径。 */
  previousPath?: string
}

export interface BaiduImportResult {
  rootPath: string
  playlistId: string
  scanned: number
  added: number
  updated: number
  removed: number
  addedTracks: SyncTrackDetail[]
  updatedTracks: SyncTrackDetail[]
  removedTracks: SyncTrackDetail[]
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

export interface TrackContextMenuRequest {
  playlists: Array<Pick<PlaylistSummary, 'id' | 'name'>>
  canRemoveFromQueue: boolean
  canRemoveFromPlaylist: boolean
}

export type TrackContextMenuAction =
  | { type: 'play' | 'playNext' | 'addToQueue' | 'showDetails' | 'removeFromQueue' | 'removeFromPlaylist' }
  | { type: 'addToPlaylist'; playlistId: string }

export interface SongLyricsLine {
  original: string
  translated: string
}

export interface SongInfoMeta {
  id: string
  path: string
  title: string
  intro: string
  lyrics: string | SongLyricsLine[]
  lyricsBilingual: SongLyricsLine[]
  source: string
  model: string
  found: boolean
  reason?: string
  updatedAt: number
}

export interface SongInfoToolCall {
  name: string
  status: 'planning' | 'running' | 'done'
}

/** REST SSE `tools` 事件的负载结构（GUI 进度走任务摘要，不走增量事件）。 */
export interface SongInfoToolStatus {
  toolCallCount: number
  currentTool: string
  toolCalls: SongInfoToolCall[]
}

/** 检索任务状态：running = 进行中；interrupted = 上一进程退出时仍在运行。 */
export type SongInfoTaskStatus =
  | 'running'
  | 'succeeded'
  | 'not_found'
  | 'failed'
  | 'canceled'
  | 'interrupted'

/** 歌曲检索任务摘要：列表只暴露摘要，结果快照经 songInfoGetTaskResult 懒加载。 */
export interface SongInfoTask {
  id: string
  trackId: string | null
  title: string
  artist: string | null
  model: string
  status: SongInfoTaskStatus
  /** epoch ms */
  startedAt: number
  /** epoch ms；运行中为 null */
  finishedAt: number | null
  toolCallCount: number
  currentTool: string | null
  message: string | null
}

export interface TrackDownloadResult {
  path: string
  bytes: number
  source: string
}

export interface AiConfig {
  piWebUrl: string
  defaultModel: string
  /** 自定义歌曲信息搜索提示词；空 = 内置默认。支持 {query} 占位符 */
  songInfoPrompt?: string
}

export interface AiModelInfo {
  id: string
  name?: string
  /** 上游 provider，如 anthropic / opencode；网关未返回时从 id 前缀推断 */
  provider?: string
}

export interface AiTestResult {
  ok: boolean
  message: string
}

export interface IPCApi {
  queueSave(state: PlaybackQueueState): Promise<void>
  queueLoad(): Promise<PlaybackQueueState | null>
  getSources(): Promise<LibrarySource[]>
  listTracks(sourceId: string): Promise<Track[]>
  listTracksPage(sourceId: string, offset: number, limit: number, search?: string,
    identified?: 'all' | 'identified' | 'unidentified'): Promise<TracksPage>
  trackGetDetail(id: string): Promise<TrackDetail | null>
  openLocalTracks(): Promise<Track[]>
  baiduGetStatus(): Promise<BaiduAuthStatus>
  baiduLogin(): Promise<BaiduAuthStatus>
  baiduLogout(): Promise<BaiduAuthStatus>
  baiduListDirectory(path: string): Promise<CloudEntry[]>
  cloudEntryContextMenu(request: CloudDownloadRequest): Promise<CloudEntryContextMenuAction | null>
  cloudDownload(request: CloudDownloadRequest): Promise<string | null>
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
  onLibraryChanged(listener: () => void): () => void
  playlistList(): Promise<PlaylistSummary[]>
  playlistCreate(name: string): Promise<PlaylistSummary>
  playlistRename(id: string, name: string): Promise<PlaylistSummary>
  playlistDelete(id: string): Promise<void>
  playlistListTracks(playlistId: string): Promise<Track[]>
  playlistAddTrack(playlistId: string, trackId: string): Promise<void>
  playlistRemoveTrack(playlistId: string, trackId: string): Promise<void>
  favoritesList(): Promise<Track[]>
  favoritesAdd(track: string | Track): Promise<void>
  favoritesRemove(trackId: string): Promise<void>
  updateGetStatus(): Promise<UpdateSnapshot>
  updateCheck(): Promise<UpdateSnapshot>
  updateDownload(): Promise<UpdateSnapshot>
  updateInstall(): Promise<boolean>
  /** 安装桌面 `corner` 命令行到用户目录，返回安装路径。 */
  cliInstall(): Promise<string>
  libraryExport(): Promise<string | null>
  libraryImport(): Promise<LibraryImportResult | null>
  pushPlaybackState(state: PlaybackState): Promise<void>
  /** 确认已执行远程播放命令；主进程据此把 CLI 请求标记为成功（不代表真的出声）。 */
  ackRemoteCommand(commandId: string): Promise<void>
  /**
   * 渲染层已订阅 `playback:remoteCommand` 且启动队列水合完成，主进程可开始下发命令。
   * 页面重载后会重新调用；主进程在导航/关闭时重置等待状态。
   */
  markRemotePlaybackReady(): Promise<void>
  trackContextMenu(request: TrackContextMenuRequest): Promise<TrackContextMenuAction | null>
  onOpenSettings(listener: () => void): () => void
  onUpdateStatus(listener: (snapshot: UpdateSnapshot) => void): () => void
  songInfoGet(identifier: string): Promise<SongInfoMeta | null>
  songInfoLookup(trackId: string): Promise<{ requestId: string }>
  /** 全部运行中任务 + 最近 100 条已结束任务（按时间倒序）。 */
  songInfoListTasks(): Promise<SongInfoTask[]>
  /** 懒加载任务结果快照（原始检索结果）；无结果返回 null。 */
  songInfoGetTaskResult(id: string): Promise<SongInfoMeta | null>
  songInfoCancelTask(id: string): Promise<void>
  /** 以原请求重新发起检索并新建任务记录；运行中不可重试；同曲目运行中任务去重。 */
  songInfoRetryTask(id: string): Promise<{ requestId: string }>
  /** 仅可删除已结束任务；不影响已缓存的歌曲信息。 */
  songInfoDeleteTask(id: string): Promise<void>
  /** 任务列表稳定变化时触发（进度事件可合并），返回取消订阅函数。 */
  onSongInfoTasksChanged(listener: () => void): () => void
  trackDownload(trackId: string, dest?: string): Promise<TrackDownloadResult>
  /** MusicBrainz 候选检索（只读，不写库）。 */
  musicBrainzLookup(trackId: string): Promise<MusicBrainzLookupResult>
  /** 保存识别结果：标题/艺术家/专辑/封面/MB id 写入曲目。 */
  trackApplyIdentification(trackId: string, identification: TrackIdentification): Promise<TrackDetail>
  aiGetConfig(): Promise<AiConfig>
  aiSaveConfig(config: AiConfig): Promise<AiConfig>
  /** piWebUrl 可选：临时覆盖配置的服务地址（设置页连通性校验用）。 */
  aiFetchModels(piWebUrl?: string): Promise<AiModelInfo[]>
  aiTestConnection(): Promise<AiTestResult>
  /** 订阅桌面 CLI 的播放命令（主进程 → 渲染进程）。返回取消订阅函数。 */
  onRemoteCommand(listener: (command: RemoteCommand) => void): () => void
}

declare global {
  interface Window {
    api: IPCApi
  }
}
