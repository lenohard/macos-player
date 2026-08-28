import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { writeFileSync, unlinkSync } from 'fs'
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'
import {
  PLAYBACK_REMOTE_COMMAND_CHANNEL,
  type BaiduImportResult,
  type PlaybackState,
  type RemoteCommand,
  type Track
} from '../shared/ipc'
import type { LibraryService } from './library'
import type { LibrarySource } from '../shared/ipc'
import type { SongInfoService } from './song-info'

const SOURCES: LibrarySource[] = [
  { id: 'local', name: '本地音乐', type: 'local' },
  { id: 'baidu', name: '百度网盘', type: 'baidu' },
  { id: 'quark', name: 'WebDAV 网盘', type: 'quark' }
]

const COMMAND_ACK_TIMEOUT_MS = 3000

interface CliServerContext {
  library: LibraryService
  songInfo: SongInfoService
  getMainWindow: () => BrowserWindow | null
  resyncLibrary: (rootPath: string) => Promise<BaiduImportResult>
}

interface CliLibrary {
  id: string
  sourceId: string
  rootPath: string
  playlistId: string | null
  lastSyncAt: number | null
  lastSyncStatus: string | null
}

interface PendingCommand {
  resolve: (ok: boolean) => void
  timer: NodeJS.Timeout
}

let server: Server | null = null
let playbackState: PlaybackState | null = null
let authToken: string | null = null
const eventSubscribers = new Set<ServerResponse>()
const pendingCommands = new Map<string, PendingCommand>()

/** 从列表中随机抽取 count 首（Fisher–Yates 部分洗牌） */
function pickRandomTracks<T>(source: T[], count: number): T[] {
  const indices = Array.from({ length: source.length }, (_, index) => index)
  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[indices[index], indices[swap]] = [indices[swap], indices[index]]
  }
  return indices.slice(0, count).map(index => source[index])
}

export function setPlaybackState(state: PlaybackState | null): void {
  playbackState = state
  broadcast({ type: 'playback', state })
}

export function ackRemoteCommand(commandId: string): void {
  const pending = pendingCommands.get(commandId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingCommands.delete(commandId)
  pending.resolve(true)
}

function broadcast(event: unknown): void {
  if (eventSubscribers.size === 0) return
  const frame = `data: ${JSON.stringify(event)}\n\n`
  for (const res of eventSubscribers) res.write(frame)
}

function portFilePath(): string {
  return join(app.getPath('userData'), 'cli-port')
}

function tokenFilePath(): string {
  return join(app.getPath('userData'), 'cli-token')
}

function writePortFile(port: number): void {
  writeFileSync(portFilePath(), String(port), 'utf8')
}

function writeTokenFile(token: string): void {
  writeFileSync(tokenFilePath(), token, { mode: 0o600, encoding: 'utf8' })
}

function removePortFile(): void {
  try {
    unlinkSync(portFilePath())
  } catch {
    // 文件不存在，忽略
  }
}

function removeTokenFile(): void {
  try {
    unlinkSync(tokenFilePath())
  } catch {
    // 文件不存在，忽略
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve(null)
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!authToken) return false
  const header = req.headers['authorization']
  if (!header) return false
  const actual = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${authToken}`)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

function searchTracks(ctx: CliServerContext, query: string, limit: number): Track[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const all: Track[] = []
  const sources = ['baidu', 'local', 'quark']
  for (const sourceId of sources) {
    try {
      const page = ctx.library.listTracksPage(sourceId, 0, limit, trimmed)
      all.push(...page.tracks)
    } catch {
      // 该源可能未初始化
    }
  }
  return all.slice(0, limit)
}

function sendRemoteCommand(ctx: CliServerContext, command: RemoteCommand): Promise<boolean> {
  const win = ctx.getMainWindow()
  if (!win || win.isDestroyed()) return Promise.resolve(false)
  // 新建窗口刚触发时渲染进程尚未就绪，等待页面加载完成再发命令，避免消息丢失
  if (win.webContents.isLoading()) {
    return new Promise<boolean>(resolve => {
      const onLoaded = (): void => {
        win.webContents.removeListener('did-finish-load', onLoaded)
        resolve(dispatchRemoteCommand(win, command))
      }
      const timeout = setTimeout(() => {
        win.webContents.removeListener('did-finish-load', onLoaded)
        resolve(false)
      }, COMMAND_ACK_TIMEOUT_MS)
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timeout)
        onLoaded()
      })
    })
  }
  return dispatchRemoteCommand(win, command)
}

function dispatchRemoteCommand(win: BrowserWindow, command: RemoteCommand): Promise<boolean> {
  const commandId = randomUUID()
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId)
      resolve(false)
    }, COMMAND_ACK_TIMEOUT_MS)
    pendingCommands.set(commandId, { resolve, timer })
    if (win.isDestroyed()) {
      clearTimeout(timer)
      pendingCommands.delete(commandId)
      resolve(false)
      return
    }
    try {
      win.webContents.send(PLAYBACK_REMOTE_COMMAND_CHANNEL, { ...command, id: commandId })
    } catch {
      clearTimeout(timer)
      pendingCommands.delete(commandId)
      resolve(false)
    }
  })
}

function clampVolume(value: unknown): number {
  const number = typeof value === 'number' ? value : NaN
  if (!Number.isFinite(number)) throw new Error('音量必须是 0~1 之间的数字。')
  return Math.min(1, Math.max(0, number))
}

async function handleRequest(
  ctx: CliServerContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1`)
  const method = req.method ?? 'GET'
  const path = url.pathname

  try {
    // GET /health — liveness probe, no auth
    if (method === 'GET' && path === '/health') {
      return jsonReply(res, 200, { ok: true })
    }

    if (!isAuthorized(req)) {
      return jsonReply(res, 401, { error: 'Unauthorized' })
    }

    // GET /status
    if (method === 'GET' && path === '/status') {
      return jsonReply(res, 200, { ok: true, running: true, playback: playbackState })
    }

    // GET /queue — current playback queue (persisted by the player)
    if (method === 'GET' && path === '/queue') {
      const queue = ctx.library.loadPlaybackQueue()
      return jsonReply(res, 200, queue ?? {
        tracks: [],
        currentIndex: -1,
        shuffle: false,
        repeatMode: 'off',
        playOrder: []
      })
    }

    // GET /events — Server-Sent Events (playback push)
    if (method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write(`data: ${JSON.stringify({ type: 'hello', playback: playbackState })}\n\n`)
      eventSubscribers.add(res)
      req.on('close', () => eventSubscribers.delete(res))
      return
    }

    // GET /sources
    if (method === 'GET' && path === '/sources') {
      return jsonReply(res, 200, SOURCES)
    }

    // GET /libraries — 已导入的音乐库（library_roots，按 rootPath 区分）
    if (method === 'GET' && path === '/libraries') {
      const rows = [
        ...ctx.library.listLibraryRoots('baidu'),
        ...ctx.library.listLibraryRoots('quark')
      ]
      const libraries: CliLibrary[] = rows.map(root => ({
        id: root.id,
        sourceId: root.source_id,
        rootPath: root.root_path,
        playlistId: root.playlist_id,
        lastSyncAt: root.last_sync_at,
        lastSyncStatus: root.last_sync_status
      }))
      return jsonReply(res, 200, { libraries })
    }

    // POST /libraries/update — 更新（重扫）某个音乐库，body { rootPath }
    if (method === 'POST' && path === '/libraries/update') {
      const body = (await readJsonBody(req)) as Record<string, unknown> | null
      const rootPath = typeof body?.rootPath === 'string' ? body.rootPath : ''
      if (!rootPath) {
        return jsonReply(res, 400, { error: 'Missing rootPath' })
      }
      try {
        const result = await ctx.resyncLibrary(rootPath)
        return jsonReply(res, 200, {
          rootPath: result.rootPath,
          playlistId: result.playlistId,
          scanned: result.scanned,
          added: result.added,
          updated: result.updated,
          removed: result.removed
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : '同步失败'
        return jsonReply(res, 404, { error: message })
      }
    }

    // GET /playlists
    if (method === 'GET' && path === '/playlists') {
      const playlists = ctx.library.listPlaylists()
      const favorites = ctx.library.listFavoriteTracks()
      return jsonReply(res, 200, [
        { id: '__favorites__', name: '我喜欢', trackCount: favorites.length, updatedAt: Date.now(), builtin: true },
        ...playlists,
      ])
    }

    // POST /playlists — create
    if (method === 'POST' && path === '/playlists') {
      const body = (await readJsonBody(req)) as Record<string, unknown> | null
      const name = typeof body?.name === 'string' ? body.name : ''
      const created = ctx.library.createPlaylist(name)
      return jsonReply(res, 201, created)
    }

    // Playlist sub-resources: /playlists/:id, /playlists/:id/tracks[/:trackId]
    const playlistMatch = path.match(/^\/playlists\/([^/]+)$/)
    if (playlistMatch) {
      const id = decodeURIComponent(playlistMatch[1])

      if (method === 'GET') {
        const summary = ctx.library.listPlaylists().find(playlist => playlist.id === id)
        if (!summary) return jsonReply(res, 404, { error: 'Playlist not found' })
        return jsonReply(res, 200, summary)
      }

      if (method === 'PATCH' || method === 'PUT') {
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const name = typeof body?.name === 'string' ? body.name : ''
        try {
          const renamed = ctx.library.renamePlaylist(id, name)
          return jsonReply(res, 200, renamed)
        } catch (error) {
          return jsonReply(res, 404, { error: error instanceof Error ? error.message : 'Playlist not found' })
        }
      }

      if (method === 'DELETE') {
        ctx.library.deletePlaylist(id)
        return jsonReply(res, 200, { ok: true })
      }
    }

    const playlistTracksMatch = path.match(/^\/playlists\/([^/]+)\/tracks$/)
    if (playlistTracksMatch) {
      const id = decodeURIComponent(playlistTracksMatch[1])

      if (method === 'GET') {
        const tracks = ctx.library.listPlaylistTracks(id)
        return jsonReply(res, 200, { tracks })
      }

      if (method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const trackId = typeof body?.trackId === 'string' ? body.trackId : null
        const trackIds = Array.isArray(body?.trackIds)
          ? (body.trackIds as unknown[]).filter((value): value is string => typeof value === 'string')
          : []
        if (trackId) trackIds.push(trackId)
        if (trackIds.length === 0) {
          return jsonReply(res, 400, { error: 'Provide trackId or trackIds' })
        }
        try {
          ctx.library.addTracksToPlaylist(id, trackIds)
          return jsonReply(res, 200, { ok: true, trackCount: trackIds.length })
        } catch (error) {
          return jsonReply(res, 404, { error: error instanceof Error ? error.message : 'Playlist not found' })
        }
      }
    }

    const playlistTrackMatch = path.match(/^\/playlists\/([^/]+)\/tracks\/([^/]+)$/)
    if (playlistTrackMatch && method === 'DELETE') {
      const id = decodeURIComponent(playlistTrackMatch[1])
      const trackId = decodeURIComponent(playlistTrackMatch[2])
      ctx.library.removeTrackFromPlaylist(id, trackId)
      return jsonReply(res, 200, { ok: true })
    }

    // GET /search?q=...&limit=20
    if (method === 'GET' && path === '/search') {
      const query = url.searchParams.get('q') ?? ''
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100)
      const tracks = searchTracks(ctx, query, limit)
      return jsonReply(res, 200, { tracks })
    }

    // POST /play
    if (method === 'POST' && path === '/play') {
      const body = (await readJsonBody(req)) as Record<string, unknown> | null
      if (!body) {
        return jsonReply(res, 400, { error: 'Missing request body' })
      }

      // playlist play
      if (body.playlistId) {
        const id = String(body.playlistId)
        let tracks = id === '__favorites__'
          ? ctx.library.listFavoriteTracks()
          : ctx.library.listPlaylistTracks(id)
        if (tracks.length === 0) {
          return jsonReply(res, 404, { error: id === '__favorites__' ? '还没有收藏任何歌曲' : 'Playlist not found or empty' })
        }
        // random20: 从歌单随机抽 20 首播放（与桌面端行为一致），避免大歌单塞满队列
        if (body.mode === 'random20') {
          tracks = pickRandomTracks(tracks, 20)
        }
        const sent = await sendRemoteCommand(ctx, { action: 'play', tracks })
        return jsonReply(res, 200, { ok: sent, trackCount: tracks.length })
      }

      // single track play
      if (body.trackId) {
        const row = ctx.library.getTrackRow(String(body.trackId))
        if (!row) {
          return jsonReply(res, 404, { error: 'Track not found' })
        }
        // Dynamically import rowToTrack to avoid circular deps
        const { rowToTrack } = await import('./library.js')
        const track = rowToTrack(row)
        const sent = await sendRemoteCommand(ctx, { action: 'playSingle', track })
        return jsonReply(res, 200, { ok: sent, track })
      }

      // search & play first result
      if (body.query) {
        const tracks = searchTracks(ctx, String(body.query), 1)
        if (tracks.length === 0) {
          return jsonReply(res, 404, { error: 'No tracks found' })
        }
        const sent = await sendRemoteCommand(ctx, { action: 'playSingle', track: tracks[0] })
        return jsonReply(res, 200, { ok: sent, track: tracks[0] })
      }

      return jsonReply(res, 400, { error: 'Provide playlistId, trackId, or query' })
    }

    // POST /toggle-play
    if (method === 'POST' && path === '/toggle-play') {
      const sent = await sendRemoteCommand(ctx, { action: 'togglePlay' })
      return jsonReply(res, 200, { ok: sent })
    }

    // POST /next
    if (method === 'POST' && path === '/next') {
      const sent = await sendRemoteCommand(ctx, { action: 'next' })
      return jsonReply(res, 200, { ok: sent })
    }

    // POST /prev
    if (method === 'POST' && path === '/prev') {
      const sent = await sendRemoteCommand(ctx, { action: 'prev' })
      return jsonReply(res, 200, { ok: sent })
    }

    // POST /shuffle
    if (method === 'POST' && path === '/shuffle') {
      const sent = await sendRemoteCommand(ctx, { action: 'shuffle' })
      return jsonReply(res, 200, { ok: sent })
    }

    // POST /repeat
    if (method === 'POST' && path === '/repeat') {
      const sent = await sendRemoteCommand(ctx, { action: 'repeat' })
      return jsonReply(res, 200, { ok: sent })
    }

    // POST /volume — body { volume: 0..1 }
    if (method === 'POST' && path === '/volume') {
      const body = (await readJsonBody(req)) as Record<string, unknown> | null
      if (!body || typeof body.volume !== 'number') {
        return jsonReply(res, 400, { error: 'Provide volume (0..1)' })
      }
      const volume = clampVolume(body.volume)
      const sent = await sendRemoteCommand(ctx, { action: 'setVolume', volume })
      return jsonReply(res, 200, { ok: sent, volume })
    }

    // POST /seek — body { positionSec } (absolute) or { offsetSec } (relative)
    if (method === 'POST' && path === '/seek') {
      const body = (await readJsonBody(req)) as Record<string, unknown> | null
      let positionSec: number
      if (body && typeof body.positionSec === 'number') {
        positionSec = body.positionSec
      } else if (body && typeof body.offsetSec === 'number') {
        positionSec = (playbackState?.positionSec ?? 0) + body.offsetSec
      } else {
        return jsonReply(res, 400, { error: 'Provide positionSec or offsetSec' })
      }
      positionSec = Math.max(0, positionSec)
      const sent = await sendRemoteCommand(ctx, { action: 'seek', positionSec })
      return jsonReply(res, 200, { ok: sent, positionSec })
    }

    // GET /favorites
    if (method === 'GET' && path === '/favorites') {
      return jsonReply(res, 200, { tracks: ctx.library.listFavoriteTracks() })
    }

    // /favorites/:trackId — add / remove / check
    const favoriteMatch = path.match(/^\/favorites\/([^/]+)$/)
    if (favoriteMatch) {
      const trackId = decodeURIComponent(favoriteMatch[1])
      if (method === 'PUT' || method === 'POST') {
        try {
          ctx.library.addFavorite(trackId)
          return jsonReply(res, 200, { ok: true })
        } catch (error) {
          return jsonReply(res, 404, { error: error instanceof Error ? error.message : 'Track not found' })
        }
      }
      if (method === 'DELETE') {
        ctx.library.removeFavorite(trackId)
        return jsonReply(res, 200, { ok: true })
      }
      if (method === 'GET') {
        return jsonReply(res, 200, { isFavorite: ctx.library.isFavorite(trackId) })
      }
    }

    // GET /history?limit=20
    if (method === 'GET' && path === '/history') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 500)
      return jsonReply(res, 200, { entries: ctx.library.listPlayHistory(limit) })
    }

    // POST /api/music/song-info (and /song-info) — query the model and persist the result.
    // The public contract uses `model`; `modelId` remains accepted for the CLI's old spelling.
    if (method === 'POST' && (path === '/api/music/song-info' || path === '/song-info')) {
      const body = (await readJsonBody(req)) as Record<string, unknown> | null
      const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
      const model = typeof body?.model === 'string'
        ? body.model
        : typeof body?.modelId === 'string' ? body.modelId : undefined
      const overrides = {
        path: typeof body?.path === 'string' ? body.path : undefined,
        title: typeof body?.title === 'string' ? body.title : undefined,
        source: typeof body?.source === 'string' ? body.source : undefined
      }
      if (!prompt.trim()) return jsonReply(res, 400, { error: 'Missing prompt' })

      // ?stream=1 返回 SSE（text/event-stream），先发 status:started + phase，再逐块推 chunk，最后发 done。
      // 未指定 stream 时维持原同步行为（JSON 响应）。
      if (url.searchParams.get('stream') === '1') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        const sseWrite = (event: string, data: unknown): void => {
          try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          } catch {
            // 连接已关闭，忽略
          }
        }
        sseWrite('status', { phase: 'started' })
        try {
          const result = await ctx.songInfo.lookupStream(
            prompt,
            chunk => sseWrite('chunk', { text: chunk }),
            model,
            overrides,
            toolStatus => sseWrite('tools', toolStatus)
          )
          sseWrite('done', result)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Internal error'
          sseWrite('error', { error: message })
        }
        try {
          res.end()
        } catch {
          // 忽略
        }
        return
      }

      const result = await ctx.songInfo.lookup(prompt, model, overrides)
      return jsonReply(res, 200, result)
    }

    // GET /api/music/song-info?path=... (and identifier=...) — read persisted metadata.
    if (method === 'GET' && (path === '/api/music/song-info' || path === '/song-info')) {
      const identifier = url.searchParams.get('path') ?? url.searchParams.get('identifier') ?? ''
      if (!identifier.trim()) return jsonReply(res, 400, { error: 'Missing path' })
      const result = ctx.songInfo.get(identifier)
      if (!result) return jsonReply(res, 404, { error: 'Song metadata not found' })
      return jsonReply(res, 200, result)
    }

    return jsonReply(res, 404, { error: 'Not found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error'
    jsonReply(res, 500, { error: message })
  }
}

export function startCliServer(
  library: LibraryService,
  getMainWindow: () => BrowserWindow | null,
  resyncLibrary: (rootPath: string) => Promise<BaiduImportResult>,
  songInfo: SongInfoService
): void {
  const ctx: CliServerContext = { library, songInfo, getMainWindow, resyncLibrary }

  authToken = randomBytes(16).toString('hex')
  writeTokenFile(authToken)

  server = createServer((req, res) => {
    void handleRequest(ctx, req, res)
  })

  server.listen(0, '127.0.0.1', () => {
    const addr = server!.address()
    if (addr && typeof addr === 'object') {
      writePortFile(addr.port)
      console.log(`[CLI] server listening on 127.0.0.1:${addr.port}`)
    }
  })

  server.on('error', error => {
    console.error('[CLI] server error:', error.message)
  })
}

export function stopCliServer(): void {
  removePortFile()
  removeTokenFile()
  for (const res of eventSubscribers) res.end()
  eventSubscribers.clear()
  for (const pending of pendingCommands.values()) {
    clearTimeout(pending.timer)
    pending.resolve(false)
  }
  pendingCommands.clear()
  if (server) {
    server.close()
    server = null
  }
}
