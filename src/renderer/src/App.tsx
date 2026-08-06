import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BaiduAuthStatus,
  CloudEntry,
  LibraryRootInfo,
  LibrarySource,
  PlaylistSummary,
  RepeatMode,
  SyncProgress,
  Track
} from '@shared/ipc'
import PlayerBar from './PlayerBar'
import SearchField from './SearchField'
import TrackDetail from './TrackDetail'

const sourceIcon: Record<LibrarySource['type'], string> = {
  local: '♫',
  baidu: 'B',
  quark: 'W'
}

const PAGE_SIZE = 100

const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav'])

function isAudioFile(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase()
  return extension ? AUDIO_EXTENSIONS.has(extension) : false
}

function parentPath(path: string): string {
  if (path === '/') return '/'
  const normalized = path.replace(/\/$/, '')
  const separator = normalized.lastIndexOf('/')
  return separator <= 0 ? '/' : normalized.slice(0, separator)
}

function folderName(path: string): string {
  if (path === '/') return '百度网盘根目录'
  const normalized = path.replace(/\/$/, '')
  const separator = normalized.lastIndexOf('/')
  return separator < 0 ? normalized : normalized.slice(separator + 1) || '百度网盘'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function messageFrom(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') || fallback
}

function pickRandomTracks(source: Track[], count: number): Track[] {
  if (source.length <= count) return [...source]
  const indices = Array.from({ length: source.length }, (_, index) => index)
  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[indices[index], indices[swap]] = [indices[swap], indices[index]]
  }
  return indices.slice(0, count).map(index => source[index])
}

function shuffleOrder(length: number, currentIndex: number): number[] {
  const order = Array.from({ length }, (_, index) => index)
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[order[index], order[swap]] = [order[swap], order[index]]
  }
  if (currentIndex >= 0 && length > 1) {
    const position = order.indexOf(currentIndex)
    if (position > 0) {
      order.splice(position, 1)
      order.unshift(currentIndex)
    }
  }
  return order
}

function matchesTrackQuery(track: Track, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    track.title.toLowerCase().includes(q) ||
    (track.artist?.toLowerCase().includes(q) ?? false)
  )
}

type MainView =
  | { kind: 'source'; sourceId: string }
  | { kind: 'playlist'; playlistId: string }
  | { kind: 'queue' }
  | { kind: 'trackDetail'; trackId: string; returnTo: MainView }

type BaiduPanel = 'browse' | 'index'

export default function App() {
  const [sources, setSources] = useState<LibrarySource[]>([])
  const [mainView, setMainView] = useState<MainView>({ kind: 'source', sourceId: 'local' })
  const [localTracks, setLocalTracks] = useState<Track[]>([])
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([])
  const [libraryTotal, setLibraryTotal] = useState(0)
  const [libraryOffset, setLibraryOffset] = useState(0)
  const [librarySearch, setLibrarySearch] = useState('')
  const [playlistSearch, setPlaylistSearch] = useState('')
  const [playlistTracks, setPlaylistTracks] = useState<Track[]>([])
  const [tracks, setTracks] = useState<Track[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [shuffle, setShuffle] = useState(false)
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off')
  const [playOrder, setPlayOrder] = useState<number[]>([])
  const [temporaryTrack, setTemporaryTrack] = useState<Track | null>(null)
  const [detailTrack, setDetailTrack] = useState<Track | null>(null)
  const [queueHydrated, setQueueHydrated] = useState(false)
  const queuePersistenceReady = useRef(false)
  const [isChoosing, setIsChoosing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [baiduStatus, setBaiduStatus] = useState<BaiduAuthStatus | null>(null)
  const [baiduEntries, setBaiduEntries] = useState<CloudEntry[]>([])
  const [baiduPath, setBaiduPath] = useState('/')
  const [baiduRoots, setBaiduRoots] = useState<LibraryRootInfo[]>([])
  const [isBaiduBusy, setIsBaiduBusy] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([])
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [importPlaylistName, setImportPlaylistName] = useState('')
  const [baiduPanel, setBaiduPanel] = useState<BaiduPanel>('browse')
  const queueRowRef = useRef<HTMLButtonElement | null>(null)

  const activeSourceId = mainView.kind === 'source' ? mainView.sourceId : 'baidu'
  const activePlaylistId = mainView.kind === 'playlist' ? mainView.playlistId : null

  const refreshPlaylists = useCallback(async (): Promise<void> => {
    try {
      setPlaylists(await window.api.playlistList())
    } catch {
      setPlaylists([])
    }
  }, [])

  const loadLibraryPage = useCallback(async (offset = 0, search?: string): Promise<void> => {
    const query = (search ?? librarySearch).trim()
    const page = await window.api.listTracksPage(
      'baidu',
      offset,
      PAGE_SIZE,
      query || undefined
    )
    setLibraryTracks(page.tracks)
    setLibraryTotal(page.total)
    setLibraryOffset(page.offset)
  }, [librarySearch])

  const runLibrarySearch = useCallback(
    (query: string): void => {
      setLibraryOffset(0)
      void loadLibraryPage(0, query)
    },
    [loadLibraryPage]
  )

  async function refreshPlaylistTracks(playlistId: string): Promise<void> {
    setPlaylistTracks(await window.api.playlistListTracks(playlistId))
  }

  function playAllFromPlaylist(): void {
    if (playlistTracks.length === 0) return
    replaceQueueAndPlay(playlistTracks)
  }

  function playRandomTwentyFromPlaylist(): void {
    if (playlistTracks.length === 0) return
    replaceQueueAndPlay(pickRandomTracks(playlistTracks, 20))
  }

  useEffect(() => {
    window.api.getSources().then(setSources).catch(() => setError('无法载入音乐来源'))
    void refreshPlaylists()
    window.api.baiduGetStatus()
      .then(status => {
        setBaiduStatus(status)
        if (status.connected) {
          void loadBaiduDirectory('/')
          void window.api.baiduListRoots().then(setBaiduRoots)
          void loadLibraryPage(0)
        }
      })
      .catch(() => setBaiduStatus({ configured: false, connected: false, expiresAt: null }))

    const unsubscribe = window.api.onSyncProgress(progress => setSyncProgress(progress))
    return unsubscribe
  }, [loadLibraryPage, refreshPlaylists])

  useEffect(() => {
    void window.api.queueLoad()
      .then(state => {
        if (state) {
          setTracks(state.tracks)
          setCurrentIndex(state.currentIndex)
          setShuffle(state.shuffle)
          setRepeatMode(state.repeatMode)
          setPlayOrder(state.playOrder)
        }
      })
      .catch(() => undefined)
      .finally(() => setQueueHydrated(true))
  }, [])

  useEffect(() => {
    setPlayOrder(previous => {
      if (tracks.length === 0) return []
      if (!shuffle) return Array.from({ length: tracks.length }, (_, index) => index)
      const isValid =
        previous.length === tracks.length &&
        new Set(previous).size === tracks.length &&
        previous.every(value => Number.isInteger(value) && value >= 0 && value < tracks.length)
      if (isValid) return previous
      return shuffleOrder(tracks.length, currentIndex)
    })
  }, [tracks.length, shuffle, currentIndex])

  useEffect(() => {
    if (!queueHydrated || tracks.length === 0) return
    const timer = window.setTimeout(() => {
      void window.api.queueSave({ tracks, currentIndex, shuffle, repeatMode, playOrder })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [tracks, currentIndex, shuffle, repeatMode, playOrder, queueHydrated])

  useEffect(() => {
    if (mainView.kind === 'queue' && !temporaryTrack) {
      queueRowRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [mainView.kind, currentIndex, temporaryTrack, tracks.length])

  const activeSource = useMemo(
    () => sources.find(source => source.id === activeSourceId),
    [activeSourceId, sources]
  )
  const activePlaylist = useMemo(
    () => playlists.find(playlist => playlist.id === activePlaylistId) ?? null,
    [activePlaylistId, playlists]
  )
  const visibleBaiduEntries = useMemo(
    () => baiduEntries.filter(entry => entry.isDirectory || isAudioFile(entry.name)),
    [baiduEntries]
  )
  const visiblePlaylistRows = useMemo(
    () =>
      playlistTracks
        .map((track, index) => ({ track, index }))
        .filter(({ track }) => matchesTrackQuery(track, playlistSearch)),
    [playlistTracks, playlistSearch]
  )

  useEffect(() => {
    setPlaylistSearch('')
  }, [activePlaylistId])

  useEffect(() => {
    if (!activePlaylistId) {
      setPlaylistTracks([])
      return
    }
    void refreshPlaylistTracks(activePlaylistId)
  }, [activePlaylistId])

  function replaceQueueAndPlay(queue: Track[]): void {
    setTemporaryTrack(null)
    setTracks(queue)
    setShuffle(false)
    setCurrentIndex(queue.length > 0 ? 0 : -1)
    setPlayOrder(Array.from({ length: queue.length }, (_, index) => index))
  }

  function playQueueIndex(index: number): void {
    if (index < 0 || index >= tracks.length) return
    setTemporaryTrack(null)
    setCurrentIndex(index)
    if (shuffle) setPlayOrder(shuffleOrder(tracks.length, index))
  }

  function playTemporary(track: Track): void {
    setTemporaryTrack(track)
  }

  function openTrackDetail(track: Track): void {
    setDetailTrack(track)
    setMainView(previous => ({
      kind: 'trackDetail',
      trackId: track.id,
      returnTo: previous.kind === 'trackDetail' ? previous.returnTo : previous
    }))
  }

  function playNext(): void {
    if (temporaryTrack) setTemporaryTrack(null)
    if (tracks.length === 0 || currentIndex < 0) return
    const order = shuffle ? playOrder : Array.from({ length: tracks.length }, (_, index) => index)
    const position = order.indexOf(currentIndex)
    if (position >= 0 && position < order.length - 1) {
      setCurrentIndex(order[position + 1])
      return
    }
    if (repeatMode === 'all' && order.length > 0) setCurrentIndex(order[0])
  }

  function playPrevious(): void {
    if (temporaryTrack) setTemporaryTrack(null)
    if (tracks.length === 0 || currentIndex < 0) return
    const order = shuffle ? playOrder : Array.from({ length: tracks.length }, (_, index) => index)
    const position = order.indexOf(currentIndex)
    if (position > 0) setCurrentIndex(order[position - 1])
  }

  function handleShuffleChange(enabled: boolean): void {
    setShuffle(enabled)
    if (tracks.length === 0) return
    setPlayOrder(
      enabled
        ? shuffleOrder(tracks.length, currentIndex)
        : Array.from({ length: tracks.length }, (_, index) => index)
    )
  }

  function handleTemporaryEnded(): void {
    setTemporaryTrack(null)
  }

  function cycleRepeatMode(): void {
    setRepeatMode(mode => mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off')
  }

  async function playLibraryTrack(pageLocalIndex: number): Promise<void> {
    if (pageLocalIndex < 0 || pageLocalIndex >= libraryTracks.length) return
    const query = librarySearch.trim()
    const cap = Math.min(libraryTotal, 10_000)
    if (cap === 0) {
      const track = libraryTracks[pageLocalIndex]
      if (track) playTemporary(track)
      return
    }
    try {
      const page = await window.api.listTracksPage('baidu', 0, cap, query || undefined)
      const globalIndex = libraryOffset + pageLocalIndex
      if (globalIndex < page.tracks.length) {
        playTemporary(page.tracks[globalIndex])
      } else {
        const track = libraryTracks[pageLocalIndex]
        if (track) playTemporary(track)
      }
    } catch {
      const track = libraryTracks[pageLocalIndex]
      if (track) playTemporary(track)
    }
  }

  async function chooseLocalTracks(): Promise<void> {
    setIsChoosing(true)
    setError(null)
    try {
      const selected = await window.api.openLocalTracks()
      setLocalTracks(selected)
      if (selected.length > 0) replaceQueueAndPlay(selected)
    } catch (reason) {
      setError(messageFrom(reason, '无法打开所选音乐，请重试'))
    } finally {
      setIsChoosing(false)
    }
  }

  async function loadBaiduDirectory(path: string): Promise<void> {
    setIsBaiduBusy(true)
    setError(null)
    try {
      setBaiduEntries(await window.api.baiduListDirectory(path))
      setBaiduPath(path)
      setImportPlaylistName(folderName(path))
    } catch (reason) {
      setError(messageFrom(reason, '无法读取百度网盘目录'))
    } finally {
      setIsBaiduBusy(false)
    }
  }

  async function loginBaidu(): Promise<void> {
    setIsBaiduBusy(true)
    setError(null)
    try {
      const status = await window.api.baiduLogin()
      setBaiduStatus(status)
      if (status.connected) {
        await loadBaiduDirectory('/')
        setBaiduRoots(await window.api.baiduListRoots())
        await loadLibraryPage(0)
      }
    } catch (reason) {
      setError(messageFrom(reason, '百度网盘登录失败'))
    } finally {
      setIsBaiduBusy(false)
    }
  }

  async function logoutBaidu(): Promise<void> {
    setIsBaiduBusy(true)
    setError(null)
    try {
      setBaiduStatus(await window.api.baiduLogout())
      setBaiduEntries([])
      setBaiduPath('/')
      setBaiduRoots([])
      setLibraryTracks([])
      setLibraryTotal(0)
    } catch (reason) {
      setError(messageFrom(reason, '退出百度网盘失败'))
    } finally {
      setIsBaiduBusy(false)
    }
  }

  async function importCurrentDirectory(): Promise<void> {
    setIsBaiduBusy(true)
    setError(null)
    setSyncProgress(null)
    try {
      const result = await window.api.baiduImportDirectory(baiduPath, importPlaylistName)
      setBaiduRoots(await window.api.baiduListRoots())
      await refreshPlaylists()
      await loadLibraryPage(0)
      setMainView({ kind: 'playlist', playlistId: result.playlistId })
    } catch (reason) {
      setError(messageFrom(reason, '导入百度目录失败'))
    } finally {
      setIsBaiduBusy(false)
      setSyncProgress(null)
    }
  }

  async function resyncRoot(rootPath: string): Promise<void> {
    setIsBaiduBusy(true)
    setError(null)
    setSyncProgress(null)
    try {
      await window.api.baiduResyncDirectory(rootPath)
      setBaiduRoots(await window.api.baiduListRoots())
      await refreshPlaylists()
      await loadLibraryPage(0)
      if (activePlaylistId) await refreshPlaylistTracks(activePlaylistId)
    } catch (reason) {
      setError(messageFrom(reason, '更新百度目录失败'))
    } finally {
      setIsBaiduBusy(false)
      setSyncProgress(null)
    }
  }

  async function openBaiduEntry(entry: CloudEntry): Promise<void> {
    if (entry.isDirectory) {
      await loadBaiduDirectory(entry.path)
      return
    }

    setIsBaiduBusy(true)
    setError(null)
    try {
      const track = await window.api.baiduCreateTrack(entry)
      playTemporary(track)
    } catch (reason) {
      setError(messageFrom(reason, '无法播放该百度网盘音频'))
    } finally {
      setIsBaiduBusy(false)
    }
  }

  async function createPlaylist(): Promise<void> {
    const name = newPlaylistName.trim()
    if (!name) return
    try {
      const created = await window.api.playlistCreate(name)
      setNewPlaylistName('')
      await refreshPlaylists()
      setMainView({ kind: 'playlist', playlistId: created.id })
    } catch (reason) {
      setError(messageFrom(reason, '创建歌单失败'))
    }
  }

  async function addCurrentTrackToPlaylist(playlistId: string): Promise<void> {
    const track = temporaryTrack ?? tracks[currentIndex]
    if (!track) return
    try {
      await window.api.playlistAddTrack(playlistId, track.id)
      await refreshPlaylists()
    } catch (reason) {
      setError(messageFrom(reason, '添加到歌单失败'))
    }
  }

  function sourceStatus(source: LibrarySource): string | null {
    if (source.type === 'local') return null
    if (source.type === 'quark') return 'WebDAV'
    if (!baiduStatus) return '检查中'
    return baiduStatus.connected ? '已连接' : '未连接'
  }

  const isLocal = mainView.kind === 'source' && activeSourceId === 'local'
  const isBaidu = mainView.kind === 'source' && activeSourceId === 'baidu'
  const isPlaylistView = mainView.kind === 'playlist'
  const currentTrack = temporaryTrack ?? tracks[currentIndex]
  const currentTrackId = currentTrack?.id ?? null
  const detailReturnView = mainView.kind === 'trackDetail' ? mainView.returnTo : null

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-drag-region" />
        <div className="brand">
          <img className="brand-mark" src="./corner-logo.png" alt="" aria-hidden="true" />
          <span>corner</span>
        </div>

        <p className="sidebar-label">音乐来源</p>
        <nav className="source-nav" aria-label="音乐来源">
          {sources.map(source => (
            <button
              key={source.id}
              className={`source-button ${mainView.kind === 'source' && source.id === activeSourceId ? 'active' : ''}`}
              onClick={() => setMainView({ kind: 'source', sourceId: source.id })}
            >
              <span className={`source-icon source-${source.type}`} aria-hidden="true">
                {sourceIcon[source.type]}
              </span>
              <span>{source.name}</span>
              {sourceStatus(source) && <span className="source-status">{sourceStatus(source)}</span>}
            </button>
          ))}
        </nav>

        <p className="sidebar-label">播放</p>
        <nav className="playlist-nav" aria-label="当前播放列表">
          <button
            className={`source-button ${mainView.kind === 'queue' ? 'active' : ''}`}
            onClick={() => setMainView({ kind: 'queue' })}
          >
            <span className="source-icon source-local" aria-hidden="true">≡</span>
            <span>播放列表</span>
            <span className="source-status">{tracks.length}</span>
          </button>
        </nav>

        <p className="sidebar-label">歌单</p>
        <div className="playlist-create-row">
          <input
            type="text"
            placeholder="新建歌单"
            value={newPlaylistName}
            onChange={event => setNewPlaylistName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void createPlaylist()
            }}
          />
          <button className="quiet-button" onClick={() => void createPlaylist()} disabled={!newPlaylistName.trim()}>
            ＋
          </button>
        </div>
        <nav className="playlist-nav" aria-label="歌单">
          {playlists.map(playlist => (
            <button
              key={playlist.id}
              className={`source-button ${activePlaylistId === playlist.id ? 'active' : ''}`}
              onClick={() => setMainView({ kind: 'playlist', playlistId: playlist.id })}
            >
              <span className="source-icon source-local" aria-hidden="true">♫</span>
              <span>{playlist.name}</span>
              <span className="source-status">{playlist.trackCount}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="status-dot" />
          SQLite 音乐库已启用
        </div>
      </aside>

      <main className="main-content">
        <header className="content-header">
          <div>
            <p className="eyebrow">{mainView.kind === 'queue' ? '播放列表' : isPlaylistView ? '歌单' : mainView.kind === 'trackDetail' ? '曲目详情' : '音乐库'}</p>
            <h1>{mainView.kind === 'queue' ? '当前播放' : isPlaylistView ? activePlaylist?.name ?? '歌单' : mainView.kind === 'trackDetail' ? detailTrack?.title ?? '曲目' : activeSource?.name ?? '音乐'}</h1>
          </div>
          {isLocal && (
            <button className="primary-button" onClick={() => void chooseLocalTracks()} disabled={isChoosing}>
              <span aria-hidden="true">＋</span>
              {isChoosing ? '正在选择…' : '选择音乐'}
            </button>
          )}
          {isBaidu && baiduStatus?.connected && (
            <button className="quiet-button" onClick={() => void logoutBaidu()} disabled={isBaiduBusy}>退出登录</button>
          )}
        </header>

        {error && <div className="inline-error" role="alert">{error}</div>}
        {syncProgress && (
          <div className="sync-banner" role="status">
            {syncProgress.phase === 'scanning'
              ? `正在扫描 ${syncProgress.currentPath} · 已处理 ${syncProgress.tracksUpserted} 首`
              : syncProgress.message ?? '同步完成'}
          </div>
        )}

        <section className="library-content">
          {detailReturnView && detailTrack && (
            <TrackDetail
              track={detailTrack}
              onBack={() => setMainView(detailReturnView)}
              onPlay={() => playTemporary(detailTrack)}
            />
          )}

          {mainView.kind === 'queue' && (
            <div className="library-panel playlist-panel">
              <div className="panel-header-row">
                <p className="panel-title">{tracks.length} 首 · 当前播放列表</p>
                <div className="queue-controls">
                  <button
                    className={`quiet-button ${shuffle ? 'active-toggle' : ''}`}
                    onClick={() => handleShuffleChange(!shuffle)}
                    disabled={tracks.length < 2}
                  >
                    {shuffle ? '随机播放' : '顺序播放'}
                  </button>
                  <button className="quiet-button" onClick={cycleRepeatMode} disabled={tracks.length === 0}>
                    {repeatMode === 'off' ? '不循环' : repeatMode === 'all' ? '列表循环' : '单曲循环'}
                  </button>
                </div>
              </div>
              <div className="track-table" role="table" aria-label="当前播放列表">
                <div className="track-table-header" role="row">
                  <span>#</span><span>标题</span><span>来源</span>
                </div>
                {tracks.map((track, index) => (
                  <button
                    key={`${track.id}-${index}`}
                    ref={index === currentIndex ? queueRowRef : undefined}
                    className={`track-row ${index === currentIndex ? 'selected' : ''}`}
                    onClick={() => playQueueIndex(index)}
                    role="row"
                  >
                    <span className="track-number">{index === currentIndex && !temporaryTrack ? '▶' : index + 1}</span>
                    <span className="track-name-cell">
                      <span className="track-name">{track.title}</span>
                      <span className="track-artist">{track.artist ?? (track.sourceId === 'baidu' ? '百度网盘' : '本地')}</span>
                    </span>
                    <span className="track-source">{track.sourceId}</span>
                  </button>
                ))}
                {tracks.length === 0 && <div className="directory-empty">播放列表还是空的。</div>}
              </div>
            </div>
          )}

          {isPlaylistView && (
            <div className="library-panel playlist-panel">
              <div className="panel-header-row playlist-panel-header">
                <p className="panel-title">
                  {playlistTracks.length} 首
                  {playlistSearch.trim() && visiblePlaylistRows.length !== playlistTracks.length
                    ? ` · 显示 ${visiblePlaylistRows.length}`
                    : ''}
                </p>
                <div className="playlist-actions">
                  <button
                    className="primary-button"
                    onClick={playAllFromPlaylist}
                    disabled={playlistTracks.length === 0}
                  >
                    全部播放
                  </button>
                  <button
                    className="quiet-button"
                    onClick={playRandomTwentyFromPlaylist}
                    disabled={playlistTracks.length === 0}
                  >
                    随机选择20首
                  </button>
                  <SearchField
                    value={playlistSearch}
                    onChange={setPlaylistSearch}
                    placeholder="搜索歌单内曲目…"
                    aria-label="搜索歌单"
                  />
                </div>
              </div>
              <div className="track-table with-actions" role="table" aria-label="歌单曲目">
                <div className="track-table-header" role="row">
                  <span>#</span><span>标题</span><span>来源</span>
                </div>
                {visiblePlaylistRows.map(({ track, index }) => (
                  <div
                    key={track.id}
                    className={`track-row ${track.id === currentTrackId ? 'selected' : ''}`}
                    role="row"
                    tabIndex={0}
                    onClick={() => openTrackDetail(track)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openTrackDetail(track)
                      }
                    }}
                  >
                    <span className="track-number">{track.id === currentTrackId ? '▶' : index + 1}</span>
                    <span className="track-name-cell">
                      <span className="track-name">{track.title}</span>
                      <span className="track-artist">{track.sourceId === 'baidu' ? '百度网盘' : '本地'}</span>
                    </span>
                    <span className="track-source">{track.sourceId}</span>
                    <button
                      className="row-play-button"
                      aria-label={`播放 ${track.title}`}
                      onClick={event => {
                        event.stopPropagation()
                        playTemporary(track)
                      }}
                    >
                      ▶
                    </button>
                  </div>
                ))}
                {playlistTracks.length === 0 && <div className="directory-empty">歌单中还没有曲目。</div>}
                {playlistTracks.length > 0 && visiblePlaylistRows.length === 0 && (
                  <div className="directory-empty">没有匹配的曲目。</div>
                )}
              </div>
            </div>
          )}

          {isLocal && localTracks.length > 0 && (
            <div className="track-table" role="table" aria-label="本地音乐">
              <div className="track-table-header" role="row">
                <span>#</span><span>标题</span><span>来源</span>
              </div>
              {localTracks.map((track, index) => (
                <button
                  key={track.id}
                  className={`track-row ${track.id === currentTrackId ? 'selected' : ''}`}
                  onClick={() => playTemporary(track)}
                  role="row"
                >
                  <span className="track-number">{track.id === currentTrackId ? '▶' : index + 1}</span>
                  <span className="track-name-cell">
                    <span className="track-name">{track.title}</span>
                    <span className="track-artist">{track.artist ?? '本地文件'}</span>
                  </span>
                  <span className="track-source">本地</span>
                </button>
              ))}
            </div>
          )}

          {isLocal && localTracks.length === 0 && (
            <div className="empty-state">
              <div className="empty-art" aria-hidden="true"><span>♪</span></div>
              <h2>添加你的第一首音乐</h2>
              <p>选择 Mac 上的音频文件，会写入本地 SQLite 音乐库。</p>
              <button className="secondary-button" onClick={() => void chooseLocalTracks()} disabled={isChoosing}>
                选择音频文件
              </button>
            </div>
          )}

          {isBaidu && !baiduStatus?.connected && (
            <div className="empty-state">
              <div className="empty-art" aria-hidden="true"><span>B</span></div>
              <h2>{baiduStatus?.configured === false ? '需要配置百度 OAuth' : '连接百度网盘'}</h2>
              <p>
                {baiduStatus?.configured === false
                  ? '请先配置 Client ID、Client Secret 和回调地址。'
                  : '登录后可浏览目录、递归导入并创建歌单。'}
              </p>
              <button
                className="secondary-button"
                onClick={() => void loginBaidu()}
                disabled={isBaiduBusy || baiduStatus?.configured === false}
              >
                {isBaiduBusy ? '正在登录…' : '登录百度网盘'}
              </button>
            </div>
          )}

          {isBaidu && baiduStatus?.connected && (
            <div className="cloud-browser">
              <div className="content-tabs">
                <button
                  className={`segment-tab ${baiduPanel === 'browse' ? 'active' : ''}`}
                  onClick={() => setBaiduPanel('browse')}
                >
                  浏览
                </button>
                <button
                  className={`segment-tab ${baiduPanel === 'index' ? 'active' : ''}`}
                  onClick={() => setBaiduPanel('index')}
                >
                  音乐库
                </button>
              </div>

              {baiduPanel === 'browse' ? (
                <>
                  <div className="import-panel">
                    <label className="import-label">
                      导入歌单名称
                      <input
                        type="text"
                        value={importPlaylistName}
                        onChange={event => setImportPlaylistName(event.target.value)}
                      />
                    </label>
                    <button
                      className="primary-button"
                      onClick={() => void importCurrentDirectory()}
                      disabled={isBaiduBusy}
                    >
                      {isBaiduBusy ? '同步中…' : '导入当前目录（递归）'}
                    </button>
                  </div>

                  <div className="path-bar">
                    <button
                      className="quiet-button"
                      onClick={() => void loadBaiduDirectory(parentPath(baiduPath))}
                      disabled={isBaiduBusy || baiduPath === '/'}
                    >
                      ‹ 返回
                    </button>
                    <span title={baiduPath}>{baiduPath}</span>
                    <button className="quiet-button" onClick={() => void loadBaiduDirectory(baiduPath)} disabled={isBaiduBusy}>
                      {isBaiduBusy ? '载入中…' : '刷新目录'}
                    </button>
                  </div>
                  <div className="track-table" role="table" aria-label="百度网盘浏览">
                    <div className="track-table-header" role="row">
                      <span>类型</span><span>名称</span><span>大小</span>
                    </div>
                    {visibleBaiduEntries.map(entry => (
                      <button
                        key={entry.id}
                        className="track-row"
                        onClick={() => void openBaiduEntry(entry)}
                        disabled={isBaiduBusy}
                        role="row"
                      >
                        <span className="track-number">{entry.isDirectory ? '▸' : '♫'}</span>
                        <span className="track-name-cell">
                          <span className="track-name">{entry.name}</span>
                          <span className="track-artist">{entry.isDirectory ? '文件夹' : '百度网盘音频'}</span>
                        </span>
                        <span className="track-source">{entry.isDirectory ? '—' : formatSize(entry.size)}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {baiduRoots.length > 0 && (
                    <div className="roots-panel">
                      <p className="panel-title">已导入目录</p>
                      {baiduRoots.map(root => (
                        <div key={root.id} className="root-row">
                          <button
                            className="quiet-button"
                            onClick={() => {
                              if (root.playlistId) {
                                setMainView({ kind: 'playlist', playlistId: root.playlistId })
                              }
                            }}
                          >
                            {root.rootPath}
                          </button>
                          <button className="quiet-button" onClick={() => void resyncRoot(root.rootPath)} disabled={isBaiduBusy}>
                            更新
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="library-panel">
                    <div className="panel-header-row">
                      <p className="panel-title">本地索引（{libraryTotal} 首）</p>
                      <SearchField
                        value={librarySearch}
                        onChange={setLibrarySearch}
                        placeholder="搜索标题…"
                        aria-label="搜索本地索引"
                        disabled={isBaiduBusy}
                        debounceMs={350}
                        onDebouncedChange={runLibrarySearch}
                      />
                      <div className="pager">
                        <button
                          className="quiet-button"
                          disabled={libraryOffset <= 0 || isBaiduBusy}
                          onClick={() => void loadLibraryPage(Math.max(0, libraryOffset - PAGE_SIZE))}
                        >
                          上一页
                        </button>
                        <span>{libraryOffset + 1}-{Math.min(libraryOffset + PAGE_SIZE, libraryTotal)}</span>
                        <button
                          className="quiet-button"
                          disabled={libraryOffset + PAGE_SIZE >= libraryTotal || isBaiduBusy}
                          onClick={() => void loadLibraryPage(libraryOffset + PAGE_SIZE)}
                        >
                          下一页
                        </button>
                      </div>
                    </div>
                    <div className="track-table" role="table" aria-label="百度本地索引">
                      <div className="track-table-header" role="row">
                        <span>#</span><span>标题</span><span>来源</span>
                      </div>
                      {libraryTracks.map((track, index) => (
                        <button
                          key={track.id}
                          className={`track-row ${track.id === currentTrackId ? 'selected' : ''}`}
                          onClick={() => void playLibraryTrack(index)}
                          role="row"
                        >
                          <span className="track-number">{libraryOffset + index + 1}</span>
                          <span className="track-name-cell">
                            <span className="track-name">{track.title}</span>
                            <span className="track-artist">百度网盘</span>
                          </span>
                          <span className="track-source">索引</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {mainView.kind === 'source' && activeSourceId === 'quark' && (
            <div className="empty-state">
              <div className="empty-art" aria-hidden="true"><span>W</span></div>
              <h2>WebDAV 尚未连接</h2>
              <p>百度链路稳定后，将接入通用 WebDAV Provider。</p>
            </div>
          )}
        </section>
      </main>

      <PlayerBar
        tracks={tracks}
        currentIndex={currentIndex}
        currentTrack={currentTrack}
        temporaryTrack={temporaryTrack !== null}
        shuffle={shuffle}
        repeatMode={repeatMode}
        playlists={playlists}
        onShuffleChange={handleShuffleChange}
        onRepeatChange={cycleRepeatMode}
        onTemporaryEnded={handleTemporaryEnded}
        onNext={playNext}
        onPrevious={playPrevious}
        onAddToPlaylist={playlistId => void addCurrentTrackToPlaylist(playlistId)}
        onOpenDetail={() => {
          if (currentTrack) openTrackDetail(currentTrack)
        }}
      />
    </div>
  )
}
