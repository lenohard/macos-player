import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BaiduAuthStatus,
  CloudEntry,
  CloudSourceId,
  LibraryRootInfo,
  LibrarySource,
  PlaybackQueueState,
  PlaylistSummary,
  RemoteCommand,
  RepeatMode,
  SyncProgress,
  Track,
  TrackContextMenuAction,
  UpdateSnapshot,
  WebDAVStatus
} from '@shared/ipc'
import PlayerBar from './PlayerBar'
import SearchField from './SearchField'
import SettingsPanel from './SettingsPanel'
import { trackSourceLabel } from './sourceLabels'
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

function folderName(path: string, rootLabel = '百度网盘'): string {
  if (path === '/') return `${rootLabel}根目录`
  const normalized = path.replace(/\/$/, '')
  const separator = normalized.lastIndexOf('/')
  return separator < 0 ? normalized : normalized.slice(separator + 1) || rootLabel
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
  | { kind: 'settings' }
  | { kind: 'trackDetail'; trackId: string; returnTo: MainView }

type CloudPanel = 'browse' | 'index'

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
  const librarySearchRef = useRef('')
  const cloudSourceRef = useRef<'baidu' | 'quark'>('baidu')
  const libraryRequestSeq = useRef(0)
  const playlistRequestSeq = useRef(0)
  const baiduDirSeq = useRef(0)
  const webdavDirSeq = useRef(0)
  const queueSaveChain = useRef<Promise<void>>(Promise.resolve())
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
  const [baiduPanel, setBaiduPanel] = useState<CloudPanel>('browse')
  const [webdavStatus, setWebdavStatus] = useState<WebDAVStatus | null>(null)
  const [webdavEntries, setWebdavEntries] = useState<CloudEntry[]>([])
  const [webdavPath, setWebdavPath] = useState('/')
  const [webdavRoots, setWebdavRoots] = useState<LibraryRootInfo[]>([])
  const [isWebdavBusy, setIsWebdavBusy] = useState(false)
  const [webdavPanel, setWebdavPanel] = useState<CloudPanel>('browse')
  const [settingsSection, setSettingsSection] = useState<'connections' | 'ai' | 'about'>('connections')
  const [webdavConfigForm, setWebdavConfigForm] = useState({ url: '', username: '', password: '' })
  const [webdavImportName, setWebdavImportName] = useState('')
  const queueRowRef = useRef<HTMLButtonElement | null>(null)
  const [remoteTogglePlay, setRemoteTogglePlay] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [cliInstallBusy, setCliInstallBusy] = useState(false)
  const [cliInstalled, setCliInstalled] = useState(false)
  const [cliInstallError, setCliInstallError] = useState<string | null>(null)
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot>({
    appVersion: '…',
    enabled: false,
    status: 'idle',
    error: null,
    progress: null,
    info: null
  })

  const updateBusy =
    updateSnapshot.status === 'checking' || updateSnapshot.status === 'downloading'

  const activeSourceId = mainView.kind === 'source' ? mainView.sourceId : 'baidu'
  const activePlaylistId = mainView.kind === 'playlist' ? mainView.playlistId : null

  useEffect(() => {
    librarySearchRef.current = librarySearch
  }, [librarySearch])

  const refreshPlaylists = useCallback(async (): Promise<void> => {
    try {
      setPlaylists(await window.api.playlistList())
    } catch {
      setPlaylists([])
    }
  }, [])

  const loadLibraryPage = useCallback(async (sourceId: string, offset = 0, search?: string): Promise<void> => {
    const seq = ++libraryRequestSeq.current
    const query = (search ?? librarySearchRef.current).trim()
    try {
      const page = await window.api.listTracksPage(sourceId, offset, PAGE_SIZE, query || undefined)
      if (seq !== libraryRequestSeq.current) return
      setLibraryTracks(page.tracks)
      setLibraryTotal(page.total)
      setLibraryOffset(page.offset)
    } catch {
      if (seq === libraryRequestSeq.current) setError('无法载入音乐索引')
    }
  }, [])

  const runLibrarySearch = useCallback(
    (query: string): void => {
      setLibraryOffset(0)
      void loadLibraryPage(cloudSourceRef.current, 0, query)
    },
    [loadLibraryPage]
  )

  useEffect(() => {
    if (mainView.kind !== 'source') return
    const next: 'baidu' | 'quark' = mainView.sourceId === 'quark' ? 'quark' : 'baidu'
    if (next !== cloudSourceRef.current) {
      cloudSourceRef.current = next
      setLibraryOffset(0)
      setLibrarySearch('')
      void loadLibraryPage(next, 0, '')
    }
  }, [mainView, loadLibraryPage])

  async function refreshPlaylistTracks(playlistId: string): Promise<void> {
    const seq = ++playlistRequestSeq.current
    try {
      const tracks = await window.api.playlistListTracks(playlistId)
      if (seq === playlistRequestSeq.current) setPlaylistTracks(tracks)
    } catch {
      // 保留上一次内容，避免竞态覆盖
    }
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
          void loadLibraryPage('baidu', 0)
        }
      })
      .catch(() => setBaiduStatus({ configured: false, connected: false, expiresAt: null }))

    window.api.webdavGetStatus()
      .then(status => {
        setWebdavStatus(status)
        setWebdavConfigForm(form => ({ ...form, url: status.url, username: status.username }))
        if (status.connected) {
          void loadWebdavDirectory('/')
          void window.api.webdavListRoots().then(setWebdavRoots)
        }
      })
      .catch(() => setWebdavStatus({ configured: false, connected: false, url: '', username: '' }))

    const unsubscribe = window.api.onSyncProgress(progress => setSyncProgress(progress))
    return unsubscribe
  }, [loadLibraryPage, refreshPlaylists])

  useEffect(() => {
    void window.api.updateGetStatus().then(setUpdateSnapshot).catch(() => {})
    return window.api.onUpdateStatus(setUpdateSnapshot)
  }, [])

  async function installCli(): Promise<void> {
    setCliInstallBusy(true)
    setCliInstallError(null)
    try {
      await window.api.cliInstall()
      setCliInstalled(true)
    } catch (installError) {
      setCliInstallError(messageFrom(installError, '命令行安装失败'))
    } finally {
      setCliInstallBusy(false)
    }
  }

  useEffect(() => window.api.onOpenSettings(() => {
    setSettingsSection('connections')
    setMainView({ kind: 'settings' })
  }), [])

  // Remote commands must always call the *latest* state, not first-render closures.
  // useEffect with [] captures stale functions; use ref to indirection.
  const remoteCommandHandler = useRef<(command: RemoteCommand) => void>(() => {})
  remoteCommandHandler.current = (command) => {
    switch (command.action) {
      case 'play':
        replaceQueueAndPlay(command.tracks)
        break
      case 'playSingle':
        playTemporary(command.track)
        break
      case 'next':
        playNext()
        break
      case 'prev':
        playPrevious()
        break
      case 'togglePlay':
        setRemoteTogglePlay(c => c + 1)
        break
      case 'shuffle':
        handleShuffleChange(!shuffle)
        break
      case 'repeat':
        cycleRepeatMode()
        break
    }
  }
  useEffect(() => window.api.onRemoteCommand(command => remoteCommandHandler.current(command)), [])


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
      const snapshot: PlaybackQueueState = { tracks, currentIndex, shuffle, repeatMode, playOrder }
      queueSaveChain.current = queueSaveChain.current
        .catch(() => undefined)
        .then(() => window.api.queueSave(snapshot))
        .catch(() => undefined)
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
  const visibleWebdavEntries = useMemo(
    () => webdavEntries.filter(entry => entry.isDirectory || isAudioFile(entry.name)),
    [webdavEntries]
  )
  const visiblePlaylistRows = useMemo(
    () => playlistTracks.filter(track => matchesTrackQuery(track, playlistSearch)),
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

  function addTrackToQueue(track: Track): void {
    setTracks(queue => [...queue, track])
  }

  function playTrackNext(track: Track): void {
    setTracks(queue => {
      const insertAt = currentIndex >= 0 ? Math.min(currentIndex + 1, queue.length) : 0
      return [...queue.slice(0, insertAt), track, ...queue.slice(insertAt)]
    })
    if (currentIndex < 0) setCurrentIndex(0)
  }

  function removeTrackFromQueue(index: number): void {
    const nextTracks = tracks.filter((_, queueIndex) => queueIndex !== index)
    setTracks(nextTracks)
    setCurrentIndex(activeIndex => {
      if (activeIndex > index) return activeIndex - 1
      if (activeIndex === index) return nextTracks.length === 0 ? -1 : Math.min(index, nextTracks.length - 1)
      return activeIndex
    })
    if (nextTracks.length === 0) {
      queueSaveChain.current = queueSaveChain.current
        .catch(() => undefined)
        .then(() => window.api.queueSave({ tracks: [], currentIndex: -1, shuffle, repeatMode, playOrder: [] }))
        .catch(() => undefined)
    }
  }

  async function showTrackContextMenu(
    track: Track,
    options: { queueIndex?: number; playlistId?: string } = {}
  ): Promise<void> {
    const action = await window.api.trackContextMenu({
      playlists: playlists.map(({ id, name }) => ({ id, name })),
      canRemoveFromQueue: options.queueIndex !== undefined,
      canRemoveFromPlaylist: options.playlistId !== undefined
    })
    if (!action) return
    handleTrackMenuAction(track, action, options)
  }

  function handleTrackMenuAction(
    track: Track,
    action: TrackContextMenuAction,
    options: { queueIndex?: number; playlistId?: string }
  ): void {
    if (action.type === 'play') {
      if (options.queueIndex !== undefined) playQueueIndex(options.queueIndex)
      else playTemporary(track)
    } else if (action.type === 'playNext') {
      playTrackNext(track)
    } else if (action.type === 'addToQueue') {
      addTrackToQueue(track)
    } else if (action.type === 'showDetails') {
      openTrackDetail(track)
    } else if (action.type === 'removeFromQueue' && options.queueIndex !== undefined) {
      removeTrackFromQueue(options.queueIndex)
    } else if (action.type === 'removeFromPlaylist' && options.playlistId) {
      void window.api.playlistRemoveTrack(options.playlistId, track.id)
        .then(async () => {
          await refreshPlaylistTracks(options.playlistId!)
          await refreshPlaylists()
        })
        .catch(reason => setError(messageFrom(reason, '无法从歌单移除曲目')))
    } else if (action.type === 'addToPlaylist') {
      void window.api.playlistAddTrack(action.playlistId, track.id)
        .then(refreshPlaylists)
        .catch(reason => setError(messageFrom(reason, '添加到歌单失败')))
    }
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

  function playLibraryTrack(pageLocalIndex: number): void {
    if (pageLocalIndex < 0 || pageLocalIndex >= libraryTracks.length) return
    const track = libraryTracks[pageLocalIndex]
    if (track) playTemporary(track)
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
    const seq = ++baiduDirSeq.current
    setIsBaiduBusy(true)
    setError(null)
    try {
      const entries = await window.api.baiduListDirectory(path)
      if (seq !== baiduDirSeq.current) return
      setBaiduEntries(entries)
      setBaiduPath(path)
      setImportPlaylistName(folderName(path))
    } catch (reason) {
      if (seq === baiduDirSeq.current) setError(messageFrom(reason, '无法读取百度网盘目录'))
    } finally {
      if (seq === baiduDirSeq.current) setIsBaiduBusy(false)
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
        await loadLibraryPage('baidu', 0)
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
      await loadLibraryPage('baidu', 0)
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
      await loadLibraryPage('baidu', 0)
      if (activePlaylistId) await refreshPlaylistTracks(activePlaylistId)
    } catch (reason) {
      setError(messageFrom(reason, '更新百度目录失败'))
    } finally {
      setIsBaiduBusy(false)
      setSyncProgress(null)
    }
  }

  async function downloadCloudEntry(sourceId: CloudSourceId, entry: CloudEntry): Promise<void> {
    if (entry.isDirectory) return
    const setBusy = sourceId === 'baidu' ? setIsBaiduBusy : setIsWebdavBusy
    setBusy(true)
    setError(null)
    try {
      await window.api.cloudDownload({ sourceId, entry })
    } catch (reason) {
      setError(messageFrom(reason, '下载文件失败'))
    } finally {
      setBusy(false)
    }
  }

  async function showCloudEntryContextMenu(sourceId: CloudSourceId, entry: CloudEntry): Promise<void> {
    if (entry.isDirectory) return
    try {
      const action = await window.api.cloudEntryContextMenu({ sourceId, entry })
      if (action?.type === 'download') await downloadCloudEntry(sourceId, entry)
    } catch (reason) {
      setError(messageFrom(reason, '无法打开文件菜单'))
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

  async function loadWebdavDirectory(path: string): Promise<void> {
    const seq = ++webdavDirSeq.current
    setIsWebdavBusy(true)
    setError(null)
    try {
      const entries = await window.api.webdavListDirectory(path)
      if (seq !== webdavDirSeq.current) return
      setWebdavEntries(entries)
      setWebdavPath(path)
      setWebdavImportName(folderName(path, 'WebDAV'))
    } catch (reason) {
      if (seq === webdavDirSeq.current) setError(messageFrom(reason, '无法读取 WebDAV 目录'))
    } finally {
      if (seq === webdavDirSeq.current) setIsWebdavBusy(false)
    }
  }

  async function disconnectWebdav(): Promise<void> {
    setIsWebdavBusy(true)
    setError(null)
    try {
      setWebdavStatus(await window.api.webdavDisconnect())
      setWebdavEntries([])
      setWebdavPath('/')
      setWebdavRoots([])
      setWebdavConfigForm({ url: '', username: '', password: '' })
      setLibraryTracks([])
      setLibraryTotal(0)
    } catch (reason) {
      setError(messageFrom(reason, '断开 WebDAV 失败'))
    } finally {
      setIsWebdavBusy(false)
    }
  }

  async function saveWebdavConfig(): Promise<void> {
    setIsWebdavBusy(true)
    setError(null)
    try {
      const status = await window.api.webdavSaveConfig({
        url: webdavConfigForm.url.trim(),
        username: webdavConfigForm.username.trim(),
        password: webdavConfigForm.password
      })
      setWebdavStatus(status)
      if (status.connected) {
        setWebdavConfigForm(form => ({ ...form, password: '' }))
        await loadWebdavDirectory('/')
        setWebdavRoots(await window.api.webdavListRoots())
        await loadLibraryPage('quark', 0)
      }
    } catch (reason) {
      setError(messageFrom(reason, '连接 WebDAV 失败'))
    } finally {
      setIsWebdavBusy(false)
    }
  }

  async function importWebdavDirectory(): Promise<void> {
    setIsWebdavBusy(true)
    setError(null)
    setSyncProgress(null)
    try {
      const result = await window.api.webdavImportDirectory(webdavPath, webdavImportName)
      setWebdavRoots(await window.api.webdavListRoots())
      await refreshPlaylists()
      await loadLibraryPage('quark', 0)
      setMainView({ kind: 'playlist', playlistId: result.playlistId })
    } catch (reason) {
      setError(messageFrom(reason, '导入 WebDAV 目录失败'))
    } finally {
      setIsWebdavBusy(false)
      setSyncProgress(null)
    }
  }

  async function resyncWebdavRoot(rootPath: string): Promise<void> {
    setIsWebdavBusy(true)
    setError(null)
    setSyncProgress(null)
    try {
      await window.api.webdavResyncDirectory(rootPath)
      setWebdavRoots(await window.api.webdavListRoots())
      await refreshPlaylists()
      await loadLibraryPage('quark', 0)
      if (activePlaylistId) await refreshPlaylistTracks(activePlaylistId)
    } catch (reason) {
      setError(messageFrom(reason, '更新 WebDAV 目录失败'))
    } finally {
      setIsWebdavBusy(false)
      setSyncProgress(null)
    }
  }

  async function openWebdavEntry(entry: CloudEntry): Promise<void> {
    if (entry.isDirectory) {
      await loadWebdavDirectory(entry.path)
      return
    }

    setIsWebdavBusy(true)
    setError(null)
    try {
      const track = await window.api.webdavCreateTrack(entry)
      playTemporary(track)
    } catch (reason) {
      setError(messageFrom(reason, '无法播放该 WebDAV 音频'))
    } finally {
      setIsWebdavBusy(false)
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
    if (source.type === 'quark') {
      if (!webdavStatus) return '检查中'
      return webdavStatus.connected ? '已连接' : '未连接'
    }
    if (!baiduStatus) return '检查中'
    return baiduStatus.connected ? '已连接' : '未连接'
  }

  const isLocal = mainView.kind === 'source' && activeSourceId === 'local'
  const isBaidu = mainView.kind === 'source' && activeSourceId === 'baidu'
  const isQuark = mainView.kind === 'source' && activeSourceId === 'quark'
  const isPlaylistView = mainView.kind === 'playlist'
  const currentTrack = temporaryTrack ?? tracks[currentIndex]
  const currentTrackId = currentTrack?.id ?? null
  const detailReturnView = mainView.kind === 'trackDetail' ? mainView.returnTo : null

  // Push playback state to main for CLI /status
  useEffect(() => {
    void window.api.pushPlaybackState({
      isPlaying,
      currentTrack: currentTrack ?? null,
      queueLength: tracks.length,
      currentIndex,
      shuffle,
      repeatMode
    })
  }, [isPlaying, currentTrack, tracks.length, currentIndex, shuffle, repeatMode])

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
          {sources.map(source => {
            const status = sourceStatus(source)
            return (
              <button
                key={source.id}
                className={`source-button ${mainView.kind === 'source' && source.id === activeSourceId ? 'active' : ''}`}
                onClick={() => setMainView({ kind: 'source', sourceId: source.id })}
              >
                <span className={`source-icon source-${source.type}`} aria-hidden="true">
                  {sourceIcon[source.type]}
                </span>
                <span>{source.name}</span>
                {status && <span className="source-status">{status}</span>}
              </button>
            )
          })}
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
        <nav className="playlist-nav playlist-list" aria-label="歌单">
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

        <button
          type="button"
          className={`source-button sidebar-settings ${mainView.kind === 'settings' ? 'active' : ''}`}
          onClick={() => {
            setSettingsSection('connections')
            setMainView({ kind: 'settings' })
          }}
        >
          <span className="source-icon source-local" aria-hidden="true">⚙</span>
          <span>设置</span>
          <span className="source-status">⌘,</span>
        </button>

        <div className="sidebar-footer">
          <span className="status-dot" />
          SQLite 音乐库已启用
        </div>
      </aside>

      <main className="main-content">
        <header className="content-header">
          <div>
            <p className="eyebrow">
              {mainView.kind === 'settings'
                ? '偏好设置'
                : mainView.kind === 'queue'
                  ? '播放列表'
                  : isPlaylistView
                    ? '歌单'
                    : mainView.kind === 'trackDetail'
                      ? '曲目详情'
                      : '音乐库'}
            </p>
            <h1>
              {mainView.kind === 'settings'
                ? settingsSection === 'connections' ? '连接' : settingsSection === 'ai' ? '大模型' : '关于 corner'
                : mainView.kind === 'queue'
                  ? '当前播放'
                  : isPlaylistView
                    ? activePlaylist?.name ?? '歌单'
                    : mainView.kind === 'trackDetail'
                      ? detailTrack?.title ?? '曲目'
                      : activeSource?.name ?? '音乐'}
            </h1>
          </div>
          {isLocal && (
            <button className="primary-button" onClick={() => void chooseLocalTracks()} disabled={isChoosing}>
              <span aria-hidden="true">＋</span>
              {isChoosing ? '正在选择…' : '选择音乐'}
            </button>
          )}
          {isBaidu && (
            <button className="quiet-button" onClick={() => {
              setSettingsSection('connections')
              setMainView({ kind: 'settings' })
            }}>连接设置</button>
          )}
          {isQuark && (
            <button className="quiet-button" onClick={() => {
              setSettingsSection('connections')
              setMainView({ kind: 'settings' })
            }}>连接设置</button>
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
          {mainView.kind === 'settings' && (
            <SettingsPanel
              section={settingsSection}
              onSectionChange={setSettingsSection}
              baiduStatus={baiduStatus}
              baiduBusy={isBaiduBusy}
              onBaiduLogin={() => void loginBaidu()}
              onBaiduLogout={() => void logoutBaidu()}
              webdavStatus={webdavStatus}
              webdavBusy={isWebdavBusy}
              webdavForm={webdavConfigForm}
              onWebdavFormChange={setWebdavConfigForm}
              onWebdavSave={() => void saveWebdavConfig()}
              onWebdavDisconnect={() => void disconnectWebdav()}
              updateSnapshot={updateSnapshot}
              updateBusy={updateBusy}
              cliBusy={cliInstallBusy}
              cliInstalled={cliInstalled}
              cliError={cliInstallError}
              onCliInstall={() => void installCli()}
              onUpdateCheck={() => void window.api.updateCheck().then(setUpdateSnapshot)}
              onUpdateDownload={() => void window.api.updateDownload().then(setUpdateSnapshot)}
              onUpdateInstall={() => void window.api.updateInstall()}
            />
          )}

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
                    onContextMenu={event => {
                      event.preventDefault()
                      void showTrackContextMenu(track, { queueIndex: index })
                    }}
                    aria-label={`${track.title}，${trackSourceLabel(track.sourceId)}`}
                    role="row"
                  >
                    <span className="track-number">{index === currentIndex && !temporaryTrack ? '▶' : index + 1}</span>
                    <span className="track-name-cell">
                      <span className="track-name">{track.title}</span>
                      <span className="track-artist">{track.artist ?? trackSourceLabel(track.sourceId)}</span>
                    </span>
                    <span className="track-source">{trackSourceLabel(track.sourceId)}</span>
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
                {visiblePlaylistRows.map((track, rowIndex) => (
                  <div
                    key={track.id}
                    className={`track-row ${track.id === currentTrackId ? 'selected' : ''}`}
                    role="row"
                    tabIndex={0}
                    onClick={() => openTrackDetail(track)}
                    onContextMenu={event => {
                      event.preventDefault()
                      if (activePlaylistId) void showTrackContextMenu(track, { playlistId: activePlaylistId })
                    }}
                    aria-label={`${track.title}，${trackSourceLabel(track.sourceId)}`}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openTrackDetail(track)
                      }
                    }}
                  >
                    <span className="track-number">{track.id === currentTrackId ? '▶' : rowIndex + 1}</span>
                    <span className="track-name-cell">
                      <span className="track-name">{track.title}</span>
                      <span className="track-artist">{trackSourceLabel(track.sourceId)}</span>
                    </span>
                    <span className="track-source">{trackSourceLabel(track.sourceId)}</span>
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
                  onContextMenu={event => {
                    event.preventDefault()
                    void showTrackContextMenu(track)
                  }}
                  aria-label={`${track.title}，本地`}
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
                onClick={() => {
                  setSettingsSection('connections')
                  setMainView({ kind: 'settings' })
                }}
              >
                打开连接设置
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
                        onContextMenu={event => {
                          event.preventDefault()
                          void showCloudEntryContextMenu('baidu', entry)
                        }}
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
                          onClick={() => void loadLibraryPage('baidu', Math.max(0, libraryOffset - PAGE_SIZE))}
                        >
                          上一页
                        </button>
                        <span>{libraryTotal === 0 ? '0 首' : `${libraryOffset + 1}-${Math.min(libraryOffset + PAGE_SIZE, libraryTotal)}`}</span>
                        <button
                          className="quiet-button"
                          disabled={libraryOffset + PAGE_SIZE >= libraryTotal || isBaiduBusy}
                          onClick={() => void loadLibraryPage('baidu', libraryOffset + PAGE_SIZE)}
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
                          onContextMenu={event => {
                            event.preventDefault()
                            void showTrackContextMenu(track)
                          }}
                          aria-label={`${track.title}，百度网盘`}
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

          {isQuark && !webdavStatus?.connected && (
            <div className="empty-state">
              <div className="empty-art" aria-hidden="true"><span>W</span></div>
              <h2>连接 WebDAV 网盘</h2>
              <p>请在设置中填写服务器地址与账号，连接后即可浏览和导入音乐。</p>
              <button className="secondary-button" onClick={() => {
                setSettingsSection('connections')
                setMainView({ kind: 'settings' })
              }}>
                打开连接设置
              </button>
            </div>
          )}

          {isQuark && webdavStatus?.connected && (
            <div className="cloud-browser">
              <div className="content-tabs">
                <button
                  className={`segment-tab ${webdavPanel === 'browse' ? 'active' : ''}`}
                  onClick={() => setWebdavPanel('browse')}
                >
                  浏览
                </button>
                <button
                  className={`segment-tab ${webdavPanel === 'index' ? 'active' : ''}`}
                  onClick={() => setWebdavPanel('index')}
                >
                  音乐库
                </button>
              </div>

              {webdavPanel === 'browse' ? (
                <>
                  <div className="import-panel">
                    <label className="import-label">
                      导入歌单名称
                      <input
                        type="text"
                        value={webdavImportName}
                        onChange={event => setWebdavImportName(event.target.value)}
                      />
                    </label>
                    <button
                      className="primary-button"
                      onClick={() => void importWebdavDirectory()}
                      disabled={isWebdavBusy}
                    >
                      {isWebdavBusy ? '同步中…' : '导入当前目录（递归）'}
                    </button>
                  </div>

                  <div className="path-bar">
                    <button
                      className="quiet-button"
                      onClick={() => void loadWebdavDirectory(parentPath(webdavPath))}
                      disabled={isWebdavBusy || webdavPath === '/'}
                    >
                      ‹ 返回
                    </button>
                    <span title={webdavPath}>{webdavPath}</span>
                    <button className="quiet-button" onClick={() => void loadWebdavDirectory(webdavPath)} disabled={isWebdavBusy}>
                      {isWebdavBusy ? '载入中…' : '刷新目录'}
                    </button>
                  </div>
                  <div className="track-table" role="table" aria-label="WebDAV 浏览">
                    <div className="track-table-header" role="row">
                      <span>类型</span><span>名称</span><span>大小</span>
                    </div>
                    {visibleWebdavEntries.map(entry => (
                      <button
                        key={entry.id}
                        className="track-row"
                        onClick={() => void openWebdavEntry(entry)}
                        onContextMenu={event => {
                          event.preventDefault()
                          void showCloudEntryContextMenu('quark', entry)
                        }}
                        disabled={isWebdavBusy}
                        role="row"
                      >
                        <span className="track-number">{entry.isDirectory ? '▸' : '♫'}</span>
                        <span className="track-name-cell">
                          <span className="track-name">{entry.name}</span>
                          <span className="track-artist">{entry.isDirectory ? '文件夹' : 'WebDAV 音频'}</span>
                        </span>
                        <span className="track-source">{entry.isDirectory ? '—' : formatSize(entry.size)}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {webdavRoots.length > 0 && (
                    <div className="roots-panel">
                      <p className="panel-title">已导入目录</p>
                      {webdavRoots.map(root => (
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
                          <button className="quiet-button" onClick={() => void resyncWebdavRoot(root.rootPath)} disabled={isWebdavBusy}>
                            更新
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="library-panel">
                    <div className="panel-header-row">
                      <p className="panel-title">WebDAV 索引（{libraryTotal} 首）</p>
                      <SearchField
                        value={librarySearch}
                        onChange={setLibrarySearch}
                        placeholder="搜索标题…"
                        aria-label="搜索 WebDAV 索引"
                        disabled={isWebdavBusy}
                        debounceMs={350}
                        onDebouncedChange={runLibrarySearch}
                      />
                      <div className="pager">
                        <button
                          className="quiet-button"
                          disabled={libraryOffset <= 0 || isWebdavBusy}
                          onClick={() => void loadLibraryPage('quark', Math.max(0, libraryOffset - PAGE_SIZE))}
                        >
                          上一页
                        </button>
                        <span>{libraryTotal === 0 ? '0 首' : `${libraryOffset + 1}-${Math.min(libraryOffset + PAGE_SIZE, libraryTotal)}`}</span>
                        <button
                          className="quiet-button"
                          disabled={libraryOffset + PAGE_SIZE >= libraryTotal || isWebdavBusy}
                          onClick={() => void loadLibraryPage('quark', libraryOffset + PAGE_SIZE)}
                        >
                          下一页
                        </button>
                      </div>
                    </div>
                    <div className="track-table" role="table" aria-label="WebDAV 索引">
                      <div className="track-table-header" role="row">
                        <span>#</span><span>标题</span><span>来源</span>
                      </div>
                      {libraryTracks.map((track, index) => (
                        <button
                          key={track.id}
                          className={`track-row ${track.id === currentTrackId ? 'selected' : ''}`}
                          onClick={() => playLibraryTrack(index)}
                          onContextMenu={event => {
                            event.preventDefault()
                            void showTrackContextMenu(track)
                          }}
                          aria-label={`${track.title}，WebDAV`}
                          role="row"
                        >
                          <span className="track-number">{libraryOffset + index + 1}</span>
                          <span className="track-name-cell">
                            <span className="track-name">{track.title}</span>
                            <span className="track-artist">WebDAV</span>
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
        remoteTogglePlay={remoteTogglePlay}
        onPlayingChange={setIsPlaying}
        onAddToPlaylist={playlistId => void addCurrentTrackToPlaylist(playlistId)}
        onOpenDetail={() => {
          if (currentTrack) openTrackDetail(currentTrack)
        }}
      />
    </div>
  )
}
