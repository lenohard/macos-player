import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepeatMode, Track } from '@shared/ipc'
import ActionNotice, { problemHint } from '../ActionNotice'
import AiSearchCenter from '../AiSearchCenter'
import AiTrackPicker from '../AiTrackPicker'
import AppDialog from '../AppDialog'
import PlayerBar, { type PlayerBarHandle } from '../PlayerBar'
import TrackDetail from '../TrackDetail'
import useSongInfoTasks from '../useSongInfoTasks'
import { createCornerWebApi, type WebPlaylistSummary } from './api'

const PAGE_SIZE = 50
const FAVORITES_ID = '__favorites__'

type Tab = 'library' | 'playlists' | 'ai'
type Connection = 'connecting' | 'online' | 'offline'
type Selection = { id: string; name: string }
type Notice = { title: string; message?: string; tone: 'success' | 'error' }

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}


function readableRequestError(error: unknown): string {
  const hint = problemHint(error)
  const text = error instanceof Error ? error.message.trim() : ''
  if (!text) return hint
  if (/failed to fetch|load failed/i.test(text)) return '请检查网络和服务连接后重试。'
  if (hint !== '请稍后重试。') return hint
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown }
    const serverMessage = typeof body.error === 'string' ? body.error : body.message
    if (typeof serverMessage === 'string' && serverMessage.trim()) return serverMessage.trim()
  } catch {
    // A plain-text server error can be shown directly below.
  }
  return text.length <= 300 && !text.includes('<') ? text : hint
}

function orderedIndexes(length: number, currentIndex: number, shuffled: boolean): number[] {
  const indexes = Array.from({ length }, (_, index) => index)
  if (!shuffled || length < 2) return indexes
  const rest = indexes.filter(index => index !== currentIndex)
  for (let index = rest.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1))
    ;[rest[index], rest[other]] = [rest[other], rest[index]]
  }
  return currentIndex >= 0 ? [currentIndex, ...rest] : rest
}

function TrackList({ tracks, currentTrack, isPlaying, onPlay, onDetail }: {
  tracks: Track[]
  currentTrack?: Track
  isPlaying: boolean
  onPlay(index: number): void
  onDetail(track: Track): void
}) {
  return (
    <ol className="web-track-list" data-testid="track-list">
      {tracks.map((track, index) => {
        const active = currentTrack?.id === track.id
        return (
          <li key={`${track.id}-${index}`} className={active ? 'is-current' : ''}>
            <button type="button" className="web-track-play" onClick={() => onPlay(index)}
              aria-label={`播放 ${track.title}`}>
              <span className="web-track-symbol" aria-hidden="true">{active && isPlaying ? '▶' : index + 1}</span>
              <span className="web-track-copy">
                <strong>{track.title}</strong>
                <span>{track.artist || '未知艺术家'}</span>
              </span>
              {track.identified && <span className="track-flag" title="已完成 MusicBrainz 识别">MB</span>}
              <time>{formatDuration(track.durationSec)}</time>
            </button>
            <button type="button" className="web-track-detail" onClick={() => onDetail(track)}
              aria-label={`查看 ${track.title} 详情`}>详情</button>
          </li>
        )
      })}
    </ol>
  )
}

function NavIcon({ tab }: { tab: Tab }) {
  if (tab === 'library') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12M9 9l10-2" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg>
  }
  if (tab === 'playlists') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h11M4 11h11M4 16h7M17 16V6l4 1M17 16a3 3 0 1 0 3 3" /></svg>
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3ZM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></svg>
}

export default function WebApp() {
  const [connection, setConnection] = useState<Connection>('connecting')
  const api = useMemo(() => createCornerWebApi(reachable => {
    setConnection(reachable ? 'online' : 'offline')
  }), [])
  const playerRef = useRef<PlayerBarHandle>(null)
  const mainRef = useRef<HTMLElement>(null)

  const [activeTab, setActiveTab] = useState<Tab>('library')
  const [detailTrack, setDetailTrack] = useState<Track | null>(null)
  const [trackDialog, setTrackDialog] = useState<'edit' | 'delete' | null>(null)
  const [query, setQuery] = useState('')
  const [identifiedFilter, setIdentifiedFilter] = useState<'all' | 'identified' | 'unidentified'>('all')
  const [loadedQuery, setLoadedQuery] = useState('')
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([])
  const [libraryTotal, setLibraryTotal] = useState(0)
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [libraryLoadingMore, setLibraryLoadingMore] = useState(false)
  const [libraryError, setLibraryError] = useState(false)
  const [libraryReload, setLibraryReload] = useState(0)
  const libraryGenerationRef = useRef(0)
  const identifiedFilterRef = useRef<'all' | 'identified' | 'unidentified'>('all')

  const [playlists, setPlaylists] = useState<WebPlaylistSummary[]>([])
  const [playlistDraft, setPlaylistDraft] = useState<{ name: string; busy: boolean; error?: string } | null>(null)
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(new Set())
  const [metadataLoading, setMetadataLoading] = useState(true)
  const [metadataError, setMetadataError] = useState(false)
  const metadataLoadedRef = useRef(false)
  const metadataInFlightRef = useRef(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [selectionTracks, setSelectionTracks] = useState<Track[]>([])
  const [selectionLoadedId, setSelectionLoadedId] = useState<string | null>(null)
  const [selectionVisibleCount, setSelectionVisibleCount] = useState(PAGE_SIZE)
  const [selectionLoading, setSelectionLoading] = useState(false)
  const [selectionError, setSelectionError] = useState(false)
  const [selectionReload, setSelectionReload] = useState(0)

  const [queue, setQueue] = useState<Track[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [playbackRequest, setPlaybackRequest] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off')
  const [playOrder, setPlayOrder] = useState<number[]>([])
  const queueRef = useRef<Track[]>([])
  const currentIndexRef = useRef(-1)
  const playOrderRef = useRef<number[]>([])
  const deferredTrackUpdatesRef = useRef(new Map<string, Track>())
  const [showTrackPicker, setShowTrackPicker] = useState(false)
  const [aiInitialTab, setAiInitialTab] = useState<'running' | 'history'>('running')
  const [aiViewKey, setAiViewKey] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [mutationBusy, setMutationBusy] = useState(false)
  const [trackMutationBusy, setTrackMutationBusy] = useState(false)
  const [trackMutationError, setTrackMutationError] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editArtist, setEditArtist] = useState('')
  const [trackEditNotice, setTrackEditNotice] = useState<string | null>(null)
  const [showRandomPicker, setShowRandomPicker] = useState(false)
  const [randomCount, setRandomCount] = useState('20')
  const [randomError, setRandomError] = useState<string | null>(null)
  const [randomFailed, setRandomFailed] = useState(false)
  const [randomFetching, setRandomFetching] = useState(false)
  const [randomResult, setRandomResult] = useState<{ count: number; tracks: Track[] } | null>(null)
  const [randomReload, setRandomReload] = useState(0)

  const { tasks: aiTasks, loading: aiLoading, loadError: aiLoadError, refresh: refreshAiTasks } = useSongInfoTasks(api)
  const completedAiIdsRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (aiLoading || aiLoadError) return
    const completed = aiTasks.filter(task => task.status === 'succeeded' && task.trackId)
    const previous = completedAiIdsRef.current
    completedAiIdsRef.current = new Set(completed.map(task => task.id))
    if (!previous) return
    const changedIds = new Set(completed.filter(task => !previous.has(task.id)).map(task => task.trackId!))
    if (!changedIds.size) return
    setLibraryReload(value => value + 1)
    setSelectionReload(value => value + 1)
    void Promise.all([...changedIds].map(id => api.trackGetDetail(id).catch(() => null))).then(updates => {
      for (const updated of updates) {
        if (!updated) continue
        const merge = (track: Track): Track => track.id === updated.id ? { ...track, ...updated } : track
        setDetailTrack(track => track?.id === updated.id ? merge(track) : track)
        if (queueRef.current[currentIndexRef.current]?.id === updated.id) {
          deferredTrackUpdatesRef.current.set(updated.id, updated)
        } else {
          setQueue(tracks => tracks.map(merge))
        }
      }
    })
  }, [aiTasks, aiLoading, aiLoadError, api])
  const runningAiIds = useMemo(
    () => new Set(aiTasks.filter(task => task.status === 'running' && task.trackId).map(task => task.trackId!)),
    [aiTasks]
  )
  const currentTrack = currentIndex >= 0 ? queue[currentIndex] : undefined
  queueRef.current = queue
  currentIndexRef.current = currentIndex
  playOrderRef.current = playOrder
  const parsedRandomCount = Number(randomCount)
  const randomCountValid = Number.isInteger(parsedRandomCount) && parsedRandomCount >= 1 && parsedRandomCount <= 500
  const randomReady = randomCountValid && randomResult !== null && randomResult.count === parsedRandomCount
    && randomResult.tracks.length > 0

  useEffect(() => {
    const pending = deferredTrackUpdatesRef.current
    if (pending.size === 0) return
    setQueue(tracks => {
      let changed = false
      const next = tracks.map(track => {
        if (track.id === currentTrack?.id) return track
        const updated = pending.get(track.id)
        if (!updated) return track
        pending.delete(track.id)
        changed = true
        return { ...track, ...updated }
      })
      return changed ? next : tracks
    })
  }, [currentTrack?.id])

  useEffect(() => {
    const search = query.trim()
    const generation = ++libraryGenerationRef.current
    let active = true
    setLibraryLoading(true)
    setLibraryError(false)
    const timer = window.setTimeout(() => {
      void api.listTracksPage('all', 0, PAGE_SIZE, search, identifiedFilterRef.current).then(page => {
        if (!active || generation !== libraryGenerationRef.current) return
        setLibraryTracks(page.tracks)
        setLibraryTotal(page.total)
        setLoadedQuery(search)
      }).catch(() => {
        if (active) setLibraryError(true)
      }).finally(() => {
        if (active) setLibraryLoading(false)
      })
    }, 220)
    return () => { active = false; window.clearTimeout(timer) }
  }, [api, query, libraryReload])

  const refreshMetadata = useCallback(async () => {
    if (metadataInFlightRef.current) return
    metadataInFlightRef.current = true
    if (!metadataLoadedRef.current) setMetadataLoading(true)
    try {
      const [nextPlaylists, favorites] = await Promise.all([api.playlistList(), api.favoritesList()])
      setPlaylists(nextPlaylists)
      setFavoriteIds(new Set(favorites.map(track => track.id)))
      setMetadataError(false)
      metadataLoadedRef.current = true
    } catch {
      setMetadataError(true)
    } finally {
      metadataInFlightRef.current = false
      setMetadataLoading(false)
    }
  }, [api])

  useEffect(() => {
    void refreshMetadata()
    const update = () => {
      if (document.visibilityState === 'visible') void refreshMetadata()
    }
    const timer = window.setInterval(update, 15000)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [refreshMetadata])

  useEffect(() => {
    if (!selection) {
      setSelectionTracks([])
      setSelectionLoadedId(null)
      return
    }
    let active = true
    setSelectionLoading(true)
    setSelectionError(false)
    const request = selection.id === FAVORITES_ID
      ? api.favoritesList()
      : api.playlistListTracks(selection.id)
    void request.then(tracks => {
      if (active) {
        setSelectionTracks(tracks)
        setSelectionLoadedId(selection.id)
      }
    }).catch(() => {
      if (active) setSelectionError(true)
    }).finally(() => {
      if (active) setSelectionLoading(false)
    })
    return () => { active = false }
  }, [api, selection, selectionReload])

  useEffect(() => {
    setSelectionVisibleCount(PAGE_SIZE)
    if (!selection) return
    const update = () => {
      if (document.visibilityState === 'visible') setSelectionReload(value => value + 1)
    }
    const timer = window.setInterval(update, 15000)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [selection?.id])

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [activeTab, detailTrack?.id, selection?.id])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!showRandomPicker) return
    const count = Number(randomCount)
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      setRandomError('请输入 1–500 之间的整数。')
      setRandomFailed(false)
      setRandomFetching(false)
      return
    }
    setRandomError(null)
    setRandomFailed(false)
    setRandomResult(null)
    setRandomFetching(true)
    let active = true
    const timer = window.setTimeout(() => {
      if (!active) return
      api.listRandomTracks(count).then(page => {
        if (!active) return
        setRandomResult({ count, tracks: page.tracks })
        if (page.tracks.length === 0) setRandomError('音乐库里还没有可播放的曲目。')
      }).catch(() => {
        if (active) {
          setRandomFailed(true)
          setRandomError('随机选曲失败，请检查连接后重试。')
        }
      }).finally(() => {
        if (active) setRandomFetching(false)
      })
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, showRandomPicker, randomCount, randomReload])

  useEffect(() => {
    const offline = () => setConnection('offline')
    const online = () => {
      setLibraryReload(value => value + 1)
      void refreshMetadata()
      refreshAiTasks()
    }
    window.addEventListener('offline', offline)
    window.addEventListener('online', online)
    return () => {
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
    }
  }, [refreshAiTasks, refreshMetadata])

  function startQueue(tracks: Track[], index: number): void {
    const track = tracks[index]
    if (!track) return
    playerRef.current?.play(track)
    setQueue(tracks)
    setCurrentIndex(index)
    setPlaybackRequest(value => value + 1)
    setPlayOrder(orderedIndexes(tracks.length, index, shuffle))
  }

  function playRandomNow(): void {
    const count = Number(randomCount)
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      setRandomError('请输入 1–500 之间的整数。')
      return
    }
    if (!randomResult || randomResult.count !== count || randomResult.tracks.length === 0) return
    setShowRandomPicker(false)
    startQueue(randomResult.tracks, 0)
  }

  function playQueueIndex(index: number): void {
    const track = queue[index]
    if (!track) return
    playerRef.current?.play(track)
    setCurrentIndex(index)
    setPlaybackRequest(value => value + 1)
  }

  function playNext(): void {
    if (queue.length === 0 || currentIndex < 0) return
    const order = shuffle ? playOrder : orderedIndexes(queue.length, currentIndex, false)
    const position = order.indexOf(currentIndex)
    if (position >= 0 && position < order.length - 1) playQueueIndex(order[position + 1])
    else if (repeatMode === 'all' && order.length > 0) playQueueIndex(order[0])
  }

  function playPrevious(): void {
    if (queue.length === 0 || currentIndex < 0) return
    const order = shuffle ? playOrder : orderedIndexes(queue.length, currentIndex, false)
    const position = order.indexOf(currentIndex)
    if (position > 0) playQueueIndex(order[position - 1])
  }

  function changeShuffle(enabled: boolean): void {
    setShuffle(enabled)
    setPlayOrder(orderedIndexes(queue.length, currentIndex, enabled))
  }

  function cycleRepeatMode(): void {
    setRepeatMode(mode => mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off')
  }

  async function loadMore(): Promise<void> {
    if (libraryLoadingMore || libraryLoading || query.trim() !== loadedQuery) return
    const generation = libraryGenerationRef.current
    const requestQuery = loadedQuery
    const offset = libraryTracks.length
    setLibraryLoadingMore(true)
    try {
      const page = await api.listTracksPage('all', offset, PAGE_SIZE, requestQuery, identifiedFilterRef.current)
      if (generation !== libraryGenerationRef.current || requestQuery !== loadedQuery) return
      setLibraryTracks(tracks => [...tracks, ...page.tracks])
      setLibraryTotal(page.total)
    } catch {
      setNotice({ title: '未能载入更多音乐', message: '请检查连接后重试。', tone: 'error' })
    } finally {
      setLibraryLoadingMore(false)
    }
  }

  async function toggleFavorite(): Promise<void> {
    if (!currentTrack || mutationBusy) return
    setMutationBusy(true)
    const removing = favoriteIds.has(currentTrack.id)
    try {
      if (removing) await api.favoritesRemove(currentTrack.id)
      else await api.favoritesAdd(currentTrack)
      setFavoriteIds(ids => {
        const next = new Set(ids)
        if (removing) next.delete(currentTrack.id)
        else next.add(currentTrack.id)
        return next
      })
      if (selection?.id === FAVORITES_ID) setSelectionReload(value => value + 1)
      void refreshMetadata()
      setNotice({ title: removing ? '已取消收藏' : '已添加到我喜欢', tone: 'success' })
    } catch {
      setNotice({ title: '收藏操作未完成', message: '请稍后重试。', tone: 'error' })
    } finally {
      setMutationBusy(false)
    }
  }

  async function addToPlaylist(playlistId: string): Promise<void> {
    if (!currentTrack || mutationBusy) return
    setMutationBusy(true)
    try {
      if (playlistId === FAVORITES_ID) await api.favoritesAdd(currentTrack)
      else await api.playlistAddTrack(playlistId, currentTrack.id)
      if (selection?.id === playlistId) setSelectionReload(value => value + 1)
      void refreshMetadata()
      setNotice({ title: '已添加到歌单', tone: 'success' })
    } catch {
      setNotice({ title: '未能添加到歌单', message: '请稍后重试。', tone: 'error' })
    } finally {
      setMutationBusy(false)
    }
  }

  function openTrackDialog(dialog: 'edit' | 'delete'): void {
    if (!detailTrack || trackMutationBusy) return
    if (dialog === 'edit') {
      setEditTitle(detailTrack.title)
      setEditArtist(detailTrack.artist ?? '')
    }
    setTrackMutationError(null)
    setTrackEditNotice(null)
    setTrackDialog(dialog)
  }

  function closeTrackDialog(): void {
    if (trackMutationBusy) return
    setTrackDialog(null)
    setTrackMutationError(null)
  }

  async function saveTrackDetails(): Promise<void> {
    const track = detailTrack
    const title = editTitle.trim()
    if (!track || trackMutationBusy) return
    if (!title) {
      setTrackMutationError('歌曲标题不能为空。')
      return
    }
    setTrackMutationBusy(true)
    setTrackMutationError(null)
    try {
      const updated = await api.trackUpdate(track.id, title, editArtist.trim() || null)
      const mergeTrack = (item: Track): Track => item.id === updated.id ? { ...item, ...updated } : item
      setDetailTrack(current => current?.id === updated.id ? { ...current, ...updated } : current)
      setLibraryTracks(tracks => tracks.map(mergeTrack))
      setSelectionTracks(tracks => tracks.map(mergeTrack))
      const playingId = queueRef.current[currentIndexRef.current]?.id
      if (playingId === updated.id) {
        // Keep the current object stable so PlayerBar does not reload and lose progress.
        deferredTrackUpdatesRef.current.set(updated.id, updated)
      } else {
        deferredTrackUpdatesRef.current.delete(updated.id)
        setQueue(tracks => tracks.map(mergeTrack))
      }
      setLibraryReload(value => value + 1)
      setSelectionReload(value => value + 1)
      setTrackDialog(null)
      setNotice({ title: '曲目信息已更新', tone: 'success' })
    } catch (error) {
      setTrackMutationError(readableRequestError(error))
    } finally {
      setTrackMutationBusy(false)
    }
  }

  async function deleteTrack(): Promise<void> {
    const track = detailTrack
    if (!track || trackMutationBusy) return
    setTrackMutationBusy(true)
    setTrackMutationError(null)
    try {
      await api.trackDelete(track.id)
      deferredTrackUpdatesRef.current.delete(track.id)
      const removedIndex = queueRef.current.findIndex(item => item.id === track.id)
      if (removedIndex >= 0) {
        const nextQueue = queueRef.current.filter(item => item.id !== track.id)
        const removingCurrent = currentIndexRef.current === removedIndex
        const nextIndex = removingCurrent
          ? -1
          : currentIndexRef.current > removedIndex ? currentIndexRef.current - 1 : currentIndexRef.current
        const nextPlayOrder = playOrderRef.current
          .filter(index => index !== removedIndex)
          .map(index => index > removedIndex ? index - 1 : index)
        queueRef.current = nextQueue
        currentIndexRef.current = nextIndex
        playOrderRef.current = nextPlayOrder
        setQueue(nextQueue)
        setCurrentIndex(nextIndex)
        setPlayOrder(nextPlayOrder)
        if (removingCurrent) setIsPlaying(false)
      }
      setDetailTrack(current => current?.id === track.id ? null : current)
      setLibraryTracks(tracks => tracks.filter(item => item.id !== track.id))
      setSelectionTracks(tracks => tracks.filter(item => item.id !== track.id))
      setLibraryReload(value => value + 1)
      setSelectionReload(value => value + 1)
      void refreshMetadata()
      setTrackDialog(null)
      setNotice({ title: '曲目已删除', message: 'Mac mini 上的原音频文件已移至废纸篓。', tone: 'success' })
    } catch (error) {
      setTrackMutationError(readableRequestError(error))
    } finally {
      setTrackMutationBusy(false)
    }
  }

  async function openTrackById(id: string): Promise<void> {
    const track = await api.trackGetDetail(id)
    if (!track) throw new Error('曲目不在音乐库中')
    setDetailTrack(track)
  }

  function retryConnection(): void {
    setConnection('connecting')
    setLibraryReload(value => value + 1)
    setSelectionReload(value => value + 1)
    void refreshMetadata()
    refreshAiTasks()
  }

  function renderLibrary() {
    return (
      <section className="web-page" aria-labelledby="web-library-title">
        <div className="web-page-heading">
          <div><p className="web-eyebrow">YOUR MUSIC</p><h1 id="web-library-title">音乐库</h1>
            <p>{libraryTotal} 首曲目{loadedQuery && ` · “${loadedQuery}”的搜索结果`}</p></div>
          <div className="web-heading-actions">
            <button type="button" className="quiet-button" disabled={libraryLoading}
              onClick={() => setLibraryReload(value => value + 1)}>{libraryLoading ? '刷新中' : '刷新'}</button>
            <button type="button" className="quiet-button" disabled={libraryLoading && !loadedQuery}
              onClick={() => { setRandomError(null); setRandomResult(null); setShowRandomPicker(true) }}>随机播放</button>
            <button type="button" className="primary-button" disabled={libraryTracks.length === 0}
              onClick={() => startQueue(libraryTracks, 0)}>播放已加载</button>
          </div>
        </div>
        <div className="filter-chips" role="group" aria-label="识别状态筛选">
          {([['all', '全部'], ['identified', '已识别'], ['unidentified', '未识别']] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={identifiedFilter === value}
              onClick={() => {
                identifiedFilterRef.current = value
                setIdentifiedFilter(value)
                setLibraryReload(current => current + 1)
              }}>{label}</button>
          ))}
        </div>
        <label className="web-search">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
          <span className="web-sr-only">搜索音乐库</span>
          <input type="search" value={query} placeholder="搜索歌名或艺术家" onChange={event => setQuery(event.target.value)} />
          {query && <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}>×</button>}
        </label>
        {libraryError && <ActionNotice title="暂时无法读取音乐库" message="Corner Web 服务可能未运行，或网络连接中断。"
          action={{ label: '重试', run: retryConnection }} />}
        {libraryTracks.length > 0 ? (
          <>
            <div className="web-list-status" role="status">
              <span>{libraryLoading && query.trim() !== loadedQuery ? '正在搜索…' : `已加载 ${libraryTracks.length} / ${libraryTotal} 首`}</span>
              <span>点按曲目即可播放</span>
            </div>
            <TrackList tracks={libraryTracks} currentTrack={currentTrack} isPlaying={isPlaying}
              onPlay={index => startQueue(libraryTracks, index)} onDetail={setDetailTrack} />
            {libraryTracks.length < libraryTotal && (
              <button type="button" className="quiet-button web-load-more" data-testid="load-more"
                disabled={libraryLoadingMore || libraryLoading || query.trim() !== loadedQuery} onClick={() => void loadMore()}>
                {libraryLoadingMore ? '正在载入…' : `再加载 ${Math.min(PAGE_SIZE, libraryTotal - libraryTracks.length)} 首`}
              </button>
            )}
          </>
        ) : libraryLoading ? (
          <div className="web-empty" role="status"><span className="web-spinner" />正在读取音乐库…</div>
        ) : !libraryError ? (
          <div className="web-empty"><span aria-hidden="true">♪</span><h2>{query ? '没有匹配的曲目' : '音乐库还是空的'}</h2>
            <p>{query ? '试试更短的关键词。' : '请检查服务器音乐目录是否挂载并完成扫描。'}</p></div>
        ) : null}
      </section>
    )
  }

  async function createPlaylist(): Promise<void> {
    if (!playlistDraft?.name.trim() || playlistDraft.busy) return
    setPlaylistDraft({ ...playlistDraft, busy: true, error: undefined })
    try {
      const created = await api.playlistCreate(playlistDraft.name.trim())
      setPlaylists(items => items.some(item => item.id === created.id) ? items : [...items, created])
      setPlaylistDraft(null)
      setSelection({ id: created.id, name: created.name })
    } catch {
      setPlaylistDraft({ ...playlistDraft, busy: false, error: '创建失败，请稍后再试。' })
    }
  }

  function renderPlaylists() {
    if (selection) {
      const visibleTracks = selectionLoadedId === selection.id ? selectionTracks : []
      const renderedTracks = visibleTracks.slice(0, selectionVisibleCount)
      return (
        <section className="web-page" aria-labelledby="web-playlist-title">
          <button type="button" className="web-back" onClick={() => setSelection(null)}>‹ 全部歌单</button>
          <div className="web-page-heading">
            <div><p className="web-eyebrow">PLAYLIST</p><h1 id="web-playlist-title">{selection.name}</h1>
              <p>{visibleTracks.length} 首曲目</p></div>
            <button type="button" className="primary-button" disabled={visibleTracks.length === 0}
              onClick={() => startQueue(visibleTracks, 0)}>播放全部</button>
          </div>
          {selectionError && <ActionNotice title="暂时无法读取歌单" action={{ label: '重试', run: () => setSelectionReload(value => value + 1) }} />}
          {visibleTracks.length > 0 ? (
            <>
              <TrackList tracks={renderedTracks} currentTrack={currentTrack} isPlaying={isPlaying}
                onPlay={index => startQueue(visibleTracks, index)} onDetail={setDetailTrack} />
              {renderedTracks.length < visibleTracks.length && (
                <button type="button" className="quiet-button web-load-more"
                  onClick={() => setSelectionVisibleCount(count => count + PAGE_SIZE)}>
                  再显示 {Math.min(PAGE_SIZE, visibleTracks.length - renderedTracks.length)} 首
                </button>
              )}
            </>
          ) : selectionLoading ? (
            <div className="web-empty" role="status"><span className="web-spinner" />正在读取歌单…</div>
          ) : !selectionError ? (
            <div className="web-empty"><span aria-hidden="true">♪</span><h2>这个歌单还没有音乐</h2><p>播放歌曲后，可通过底部播放栏添加。</p></div>
          ) : null}
        </section>
      )
    }
    return (
      <section className="web-page" aria-labelledby="web-playlists-title">
        <div className="web-page-heading">
          <div><p className="web-eyebrow">COLLECTIONS</p><h1 id="web-playlists-title">歌单</h1><p>网页曲库中的歌单</p></div>
          <button type="button" className="primary-button"
            onClick={() => setPlaylistDraft({ name: '', busy: false })}>新建歌单</button>
        </div>
        {metadataError && <ActionNotice title="暂时无法更新歌单" action={{ label: '重试', run: () => void refreshMetadata() }} />}
        {playlists.length > 0 ? (
          <div className="web-playlist-grid">
            {playlists.map(playlist => (
              <button type="button" className="web-playlist-card" key={playlist.id}
                onClick={() => setSelection({ id: playlist.id, name: playlist.name })}>
                <span className="web-playlist-icon" aria-hidden="true">{playlist.id === FAVORITES_ID ? '♥' : '♪'}</span>
                <span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首曲目</small></span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        ) : metadataLoading ? (
          <div className="web-empty" role="status"><span className="web-spinner" />正在读取歌单…</div>
        ) : !metadataError ? (
          <div className="web-empty"><span aria-hidden="true">♪</span><h2>还没有歌单</h2><p>网页版和桌面版的歌单各自保存。</p></div>
        ) : null}
      </section>
    )
  }

  function renderAi() {
    return (
      <section className="web-page" aria-labelledby="web-ai-title">
        <div className="web-page-heading">
          <div><p className="web-eyebrow">SONG INFO</p><h1 id="web-ai-title">AI 检索</h1><p>歌曲介绍、歌词与检索历史</p></div>
          <button type="button" className="primary-button web-ai-picker" data-testid="ai-picker"
            onClick={() => setShowTrackPicker(true)}>检索曲目</button>
        </div>
        <AiSearchCenter key={aiViewKey} initialTab={aiInitialTab} api={api}
          tasks={aiTasks} loading={aiLoading} loadError={aiLoadError}
          onRefresh={refreshAiTasks} onOpenTrack={openTrackById} />
      </section>
    )
  }

  return (
    <div className="web-shell" data-testid="web-shell">
      <header className="web-header">
        <div className="web-brand"><img src="./corner-logo.png" alt="" /><strong>Corner Web</strong><span>音乐，随身听</span></div>
        {connection === 'offline' ? (
          <button type="button" className="web-connection is-offline" data-testid="connection" onClick={retryConnection}>
            <span />离线 · 重试
          </button>
        ) : (
          <span className={`web-connection ${connection === 'connecting' ? 'is-connecting' : ''}`} data-testid="connection" role="status">
            <span />{connection === 'connecting' ? '连接中' : '已连接'}
          </span>
        )}
      </header>

      <nav className="web-navigation" data-testid="navigation" aria-label="主要导航">
        {(['library', 'playlists', 'ai'] as Tab[]).map(tab => (
          <button type="button" key={tab} data-testid={`nav-${tab}`} aria-current={activeTab === tab && !detailTrack ? 'page' : undefined}
            className={activeTab === tab ? 'is-active' : ''} onClick={() => { setActiveTab(tab); setDetailTrack(null) }}>
            <NavIcon tab={tab} /><span>{tab === 'library' ? '音乐库' : tab === 'playlists' ? '歌单' : 'AI'}</span>
          </button>
        ))}
      </nav>

      <main className="web-main" data-testid="main" ref={mainRef}>
        {detailTrack ? (
          <section className="web-page web-track-detail-page">
            <header className="web-detail-heading">
              <button type="button" className="web-back" onClick={() => setDetailTrack(null)}>‹ 返回</button>
              <div className="web-detail-copy"><h1>{detailTrack.title}</h1><p>{detailTrack.artist || '未知艺术家'}</p></div>
              <div className="web-detail-actions">
                <button type="button" className="quiet-button" onClick={() => openTrackDialog('edit')}>编辑</button>
                <button type="button" className="quiet-button danger" onClick={() => openTrackDialog('delete')}>删除</button>
              </div>
            </header>
            <TrackDetail key={detailTrack.id} api={api} track={detailTrack} tasks={aiTasks}
              onRefreshTasks={refreshAiTasks}
              onOpenTasks={history => {
                setAiInitialTab(history ? 'history' : 'running')
                setAiViewKey(value => value + 1)
                setActiveTab('ai')
                setDetailTrack(null)
              }}
              onBack={() => setDetailTrack(null)} onPlay={() => startQueue([detailTrack], 0)}
              onLibraryChanged={() => setLibraryReload(current => current + 1)} />
          </section>
        ) : activeTab === 'library' ? renderLibrary() : activeTab === 'playlists' ? renderPlaylists() : renderAi()}
      </main>

      <PlayerBar
        ref={playerRef}
        tracks={queue}
        currentIndex={currentIndex}
        currentTrack={currentTrack}
        playbackRequest={playbackRequest}
        temporaryTrack={false}
        shuffle={shuffle}
        repeatMode={repeatMode}
        playlists={playlists}
        onPlayingChange={setIsPlaying}
        onVolumeChange={() => {}}
        onPositionChange={() => {}}
        onShuffleChange={changeShuffle}
        onRepeatChange={cycleRepeatMode}
        onTemporaryEnded={() => {}}
        onNext={playNext}
        onPrevious={playPrevious}
        onAddToPlaylist={playlistId => void addToPlaylist(playlistId)}
        isFavorite={currentTrack !== undefined && favoriteIds.has(currentTrack.id)}
        onToggleFavorite={() => void toggleFavorite()}
        onOpenDetail={() => { if (currentTrack) setDetailTrack(currentTrack) }}
      />

      {showTrackPicker && (
        <AiTrackPicker api={api} runningIds={runningAiIds} onClose={() => setShowTrackPicker(false)} onStarted={() => {
          setShowTrackPicker(false)
          setActiveTab('ai')
          setAiInitialTab('running')
          setAiViewKey(value => value + 1)
          refreshAiTasks()
        }} />
      )}
      {playlistDraft && (
        <AppDialog title="新建歌单" compact onClose={() => { if (!playlistDraft.busy) setPlaylistDraft(null) }} footer={
          <>
            <button type="button" className="quiet-button" disabled={playlistDraft.busy} onClick={() => setPlaylistDraft(null)}>取消</button>
            <button type="submit" form="web-new-playlist" className="primary-button"
              disabled={playlistDraft.busy || !playlistDraft.name.trim()}>{playlistDraft.busy ? '创建中…' : '创建'}</button>
          </>
        }>
          <form id="web-new-playlist" className="web-track-form"
            onSubmit={event => { event.preventDefault(); void createPlaylist() }}>
            <label htmlFor="web-new-playlist-name">歌单名称</label>
            <input id="web-new-playlist-name" className="app-text-input" value={playlistDraft.name}
              autoFocus disabled={playlistDraft.busy}
              onChange={event => setPlaylistDraft({ name: event.target.value, busy: false })} />
            {playlistDraft.error && <ActionNotice title={playlistDraft.error} tone="error" />}
          </form>
        </AppDialog>
      )}
      {showRandomPicker && (
        <AppDialog title="随机播放" compact onClose={() => setShowRandomPicker(false)} footer={
          <>
            <button type="button" className="quiet-button" onClick={() => setShowRandomPicker(false)}>取消</button>
            <button type="button" className="primary-button" disabled={!randomReady}
              onClick={playRandomNow}>{randomFetching ? '选曲中…' : '开始播放'}</button>
          </>
        }>
          <div className="web-random-form">
            <label htmlFor="web-random-count">随机播放数量（1–500）</label>
            <input id="web-random-count" className="app-text-input" type="number" inputMode="numeric"
              min={1} max={500} step={1} value={randomCount}
              onChange={event => { setRandomCount(event.target.value); setRandomResult(null); setRandomError(null) }}
              onKeyDown={event => { if (event.key === 'Enter') playRandomNow() }} />
            <p>将从整个音乐库中随机选取，替换当前播放队列并立即播放；不足指定数量时播放全部曲目。</p>
            {randomError && (
              <ActionNotice title={randomError} tone="error"
                action={randomFailed ? { label: '重试', run: () => setRandomReload(value => value + 1) } : undefined}
                onDismiss={() => setRandomError(null)} />
            )}
          </div>
        </AppDialog>
      )}
      {trackDialog === 'edit' && detailTrack && (
        <AppDialog title="编辑曲目信息" compact
          onClose={closeTrackDialog} footer={
            <>
              <button type="button" className="quiet-button" disabled={trackMutationBusy} onClick={closeTrackDialog}>取消</button>
              <button type="submit" form="web-track-edit-form" className="primary-button"
                disabled={trackMutationBusy || !editTitle.trim()}>{trackMutationBusy ? '保存中…' : '保存'}</button>
            </>
          }>
          <form id="web-track-edit-form" className="web-track-form"
            onSubmit={event => { event.preventDefault(); void saveTrackDetails() }}>
            <label htmlFor="web-track-title">歌曲标题</label>
            <input id="web-track-title" className="app-text-input" value={editTitle} autoFocus
              disabled={trackMutationBusy} onChange={event => { setEditTitle(event.target.value); setTrackMutationError(null) }} />
            <label htmlFor="web-track-artist">艺术家</label>
            <input id="web-track-artist" className="app-text-input" value={editArtist} placeholder="未知艺术家"
              disabled={trackMutationBusy} onChange={event => {
                setEditArtist(event.target.value)
                setTrackMutationError(null)
                setTrackEditNotice(null)
              }} />
            {trackEditNotice && <p className="web-edit-fill-notice" role="status">{trackEditNotice}</p>}
            <p>只修改音乐库中显示的信息，不会写入音频文件标签。</p>
            <p>专辑、封面与 MusicBrainz 编号请在曲目详情页的「MusicBrainz 识别」中保存。</p>
            {trackMutationError && <ActionNotice title="未能保存曲目信息" message={trackMutationError}
              onDismiss={() => setTrackMutationError(null)} />}
          </form>
        </AppDialog>
      )}
      {notice && <div className="web-toast"><ActionNotice {...notice} onDismiss={() => setNotice(null)} /></div>}
    </div>
  )
}
