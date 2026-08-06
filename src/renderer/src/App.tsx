import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  BaiduAuthStatus,
  CloudEntry,
  LibraryRootInfo,
  LibrarySource,
  PlaylistSummary,
  SyncProgress,
  Track
} from '@shared/ipc'
import PlayerBar from './PlayerBar'

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

type MainView =
  | { kind: 'source'; sourceId: string }
  | { kind: 'playlist'; playlistId: string }

export default function App() {
  const [sources, setSources] = useState<LibrarySource[]>([])
  const [mainView, setMainView] = useState<MainView>({ kind: 'source', sourceId: 'local' })
  const [localTracks, setLocalTracks] = useState<Track[]>([])
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([])
  const [libraryTotal, setLibraryTotal] = useState(0)
  const [libraryOffset, setLibraryOffset] = useState(0)
  const [tracks, setTracks] = useState<Track[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [shuffle, setShuffle] = useState(false)
  const [playOrder, setPlayOrder] = useState<number[]>([])
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

  const activeSourceId = mainView.kind === 'source' ? mainView.sourceId : 'baidu'
  const activePlaylistId = mainView.kind === 'playlist' ? mainView.playlistId : null

  const refreshPlaylists = useCallback(async (): Promise<void> => {
    try {
      setPlaylists(await window.api.playlistList())
    } catch {
      setPlaylists([])
    }
  }, [])

  const loadLibraryPage = useCallback(async (offset = 0): Promise<void> => {
    const page = await window.api.listTracksPage('baidu', offset, PAGE_SIZE)
    setLibraryTracks(page.tracks)
    setLibraryTotal(page.total)
    setLibraryOffset(page.offset)
  }, [])

  const loadPlaylistTracks = useCallback(async (playlistId: string): Promise<void> => {
    const playlistTracks = await window.api.playlistListTracks(playlistId)
    setTracks(playlistTracks)
    setCurrentIndex(playlistTracks.length > 0 ? 0 : -1)
    setPlayOrder(shuffleOrder(playlistTracks.length, 0))
  }, [])

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
    setPlayOrder(previous => {
      if (tracks.length === 0) return []
      if (!shuffle) return Array.from({ length: tracks.length }, (_, index) => index)
      if (previous.length === tracks.length) return previous
      return shuffleOrder(tracks.length, currentIndex)
    })
  }, [tracks.length, shuffle, currentIndex])

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

  function playAtIndex(index: number, queue = tracks): void {
    if (index < 0 || index >= queue.length) return
    setTracks(queue)
    setCurrentIndex(index)
    if (shuffle) setPlayOrder(shuffleOrder(queue.length, index))
  }

  function playNext(): void {
    if (tracks.length === 0 || currentIndex < 0) return
    const order = shuffle ? playOrder : Array.from({ length: tracks.length }, (_, index) => index)
    const position = order.indexOf(currentIndex)
    if (position >= 0 && position < order.length - 1) {
      setCurrentIndex(order[position + 1])
      return
    }
    if (shuffle && order.length > 1) {
      setCurrentIndex(order[0])
    }
  }

  function playPrevious(): void {
    if (tracks.length === 0 || currentIndex < 0) return
    const order = shuffle ? playOrder : Array.from({ length: tracks.length }, (_, index) => index)
    const position = order.indexOf(currentIndex)
    if (position > 0) {
      setCurrentIndex(order[position - 1])
    }
  }

  async function chooseLocalTracks(): Promise<void> {
    setIsChoosing(true)
    setError(null)
    try {
      const selected = await window.api.openLocalTracks()
      setLocalTracks(selected)
      if (selected.length > 0) playAtIndex(0, selected)
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
      await loadPlaylistTracks(result.playlistId)
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
      if (activePlaylistId) await loadPlaylistTracks(activePlaylistId)
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
      playAtIndex(0, [track])
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
      await loadPlaylistTracks(created.id)
    } catch (reason) {
      setError(messageFrom(reason, '创建歌单失败'))
    }
  }

  async function addCurrentTrackToPlaylist(playlistId: string): Promise<void> {
    const track = tracks[currentIndex]
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
  const currentTrackId = tracks[currentIndex]?.id ?? null

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
              onClick={() => {
                setMainView({ kind: 'playlist', playlistId: playlist.id })
                void loadPlaylistTracks(playlist.id)
              }}
            >
              <span className="source-icon source-local" aria-hidden="true">≡</span>
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
            <p className="eyebrow">{isPlaylistView ? '歌单' : '音乐库'}</p>
            <h1>{isPlaylistView ? activePlaylist?.name ?? '歌单' : activeSource?.name ?? '音乐'}</h1>
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
          {isPlaylistView && (
            <div className="track-table" role="table" aria-label="歌单曲目">
              <div className="track-table-header" role="row">
                <span>#</span><span>标题</span><span>来源</span>
              </div>
              {tracks.map((track, index) => (
                <button
                  key={track.id}
                  className={`track-row ${track.id === currentTrackId ? 'selected' : ''}`}
                  onClick={() => playAtIndex(index)}
                  role="row"
                >
                  <span className="track-number">{track.id === currentTrackId ? '▶' : index + 1}</span>
                  <span className="track-name-cell">
                    <span className="track-name">{track.title}</span>
                    <span className="track-artist">{track.sourceId === 'baidu' ? '百度网盘' : '本地'}</span>
                  </span>
                  <span className="track-source">{track.sourceId}</span>
                </button>
              ))}
              {tracks.length === 0 && <div className="directory-empty">歌单中还没有曲目。</div>}
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
                  onClick={() => playAtIndex(index, localTracks)}
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
                            void loadPlaylistTracks(root.playlistId)
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
                      onClick={() => playAtIndex(index, libraryTracks)}
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
        shuffle={shuffle}
        playlists={playlists}
        onShuffleChange={setShuffle}
        onNext={playNext}
        onPrevious={playPrevious}
        onAddToPlaylist={playlistId => void addCurrentTrackToPlaylist(playlistId)}
      />
    </div>
  )
}
