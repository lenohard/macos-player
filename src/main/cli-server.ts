import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'fs'
import { randomBytes, timingSafeEqual } from 'crypto'
import { join } from 'path'
import { rowToTrack, type LibraryService, type TrackEditInput } from './library'
import { LocalTrackFileError, validateLocalTrackFile } from './local-track-file'
import { lookupDesktopTrack, lookupMusicBrainz } from './musicbrainz'
import type { BaiduImportResult, PlaybackState, RemoteCommand, Track, TrackIdentification } from '../shared/ipc'
import type { SongInfoService } from './song-info'
import { downloadTrack, type DownloadTrackDeps } from './download'
import { audioContentType, streamLocalAudio } from './track-stream'
import { serveWebAsset, serveWebAudio } from './web-serving'

const RANDOM_PLAY_MAX = 500

interface CliServerContext extends DownloadTrackDeps {
  songInfo: SongInfoService
  endpointDir: string
  desktop?: {
    sendCommand: (command: RemoteCommand) => Promise<boolean>
    resyncLibrary: (rootPath: string) => Promise<BaiduImportResult>
    onLibraryChanged: () => void
  }
}

interface CliLibrary {
  id: string
  sourceId: string
  rootPath: string
  playlistId: string | null
  lastSyncAt: number | null
  lastSyncStatus: string | null
}

let authToken: string | null = null
let playbackState: PlaybackState | null = null
const eventSubscribers = new Set<ServerResponse>()

/** 从列表中随机抽取 count 首（Fisher–Yates 部分洗牌） */
function pickRandomTracks<T>(source: T[], count: number): T[] {
  const indices = Array.from({ length: source.length }, (_, index) => index)
  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[indices[index], indices[swap]] = [indices[swap], indices[index]]
  }
  return indices.slice(0, count).map(index => source[index])
}

/** AppleDouble 伴生文件（macOS 的 ._ 元数据文件，name 以 ._ 开头）不参与随机选曲。 */
function isAppleDoubleTrack(track: Track): boolean {
  return track.title.startsWith('._')
}

/** 从整个曲库随机抽 count 首（不局限搜索/分页，排除 ._ 伴生文件）。 */
function randomLibrarySample(
  library: LibraryService,
  sourceId: string,
  count: number
): { tracks: Track[]; total: number } {
  const pool = library.listAllTracks(sourceId).filter(track => !isAppleDoubleTrack(track))
  return { tracks: pickRandomTracks(pool, count), total: pool.length }
}

function writeEndpointFile(path: string, value: string): void {
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, value, { mode: 0o600, encoding: 'utf8' })
    renameSync(temporary, path)
  } finally {
    removeEndpointFile(temporary)
  }
}

function removeEndpointFile(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[CLI] endpoint cleanup failed:', error)
  }
}

export function setPlaybackState(state: PlaybackState | null): void {
  playbackState = state
  if (!eventSubscribers.size) return
  const frame = `data: ${JSON.stringify({ type: 'playback', state })}\n\n`
  for (const res of eventSubscribers) {
    if (!res.writableNeedDrain) res.write(frame)
  }
}

class RequestBodyTooLargeError extends Error {}

function readJsonBody(req: IncomingMessage, maxBytes = Number.POSITIVE_INFINITY): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return reject(new RequestBodyTooLargeError('Request body too large'))
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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
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
  const sources = ctx.desktop ? ['baidu', 'local', 'quark'] : ['local']
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

/** 任务 API 的错误映射：不存在 404、进行中不允许 400、其余 500。 */
function taskErrorStatus(message: string): number {
  if (message === '任务不存在。') return 404
  if (message.includes('进行中')) return 400
  return 500
}

function localTrackMutationErrorStatus(error: unknown): number {
  if (error instanceof LocalTrackFileError) return error.statusCode
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('不存在')) return 404
  if (message.includes('标题') || message.includes('艺术家')) return 400
  if (message.includes('正在移入') || message.includes('已变化')) return 409
  return 500
}

/** 解析识别结果负载；不是对象时返回 null，字段非法时抛错。 */
function parseIdentification(value: unknown): TrackIdentification | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('识别结果格式无效。')
  const raw = value as Record<string, unknown>
  const recordingId = typeof raw.recordingId === 'string' ? raw.recordingId.trim() : ''
  if (!recordingId) throw new Error('识别结果缺少 recordingId。')
  const text = (key: string): string | null => {
    const item = raw[key]
    if (item === undefined || item === null) return null
    if (typeof item !== 'string') throw new Error(`识别结果字段 ${key} 必须是字符串。`)
    return item.trim() || null
  }
  const score = raw.score === undefined || raw.score === null ? null : Number(raw.score)
  if (score !== null && !Number.isFinite(score)) throw new Error('识别结果分数必须是数字。')
  return {
    recordingId,
    releaseId: text('releaseId'),
    artistId: text('artistId'),
    album: text('album'),
    coverUrl: text('coverUrl'),
    score,
    title: text('title'),
    artist: text('artist')
  }
}

async function handleRequest(
  ctx: CliServerContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1`)
  const method = req.method ?? 'GET'
  const path = url.pathname

  const read = method === 'GET' || method === 'HEAD'
  const desktop = ctx.desktop
  const mode = desktop ? 'desktop' : 'web'
  try {
    // GET /health — liveness and instance identity, no auth
    if (method === 'GET' && path === '/health') {
      return jsonReply(res, 200, { ok: true, mode })
    }

    if (!isAuthorized(req)) {
      return jsonReply(res, 401, { error: 'Unauthorized' })
    }
    if (desktop && !read && /^(?:\/playlists(?:\/|$)|\/favorites(?:\/|$)|\/tracks\/|\/import$|\/libraries\/update$)/.test(path)) {
      res.once('finish', () => {
        if (res.statusCode < 300) desktop.onLibraryChanged()
      })
    }

    // Share Hub points only to Web; the desktop listener never serves the Web UI.
    if (!desktop && read && path.startsWith('/web/')) {
      return await serveWebAsset(path, req, res)
    }
    if (method === 'GET' && path === '/tracks') {
      const requestedSourceId = url.searchParams.get('sourceId') ?? 'all'
      if (!['all', 'local'].includes(requestedSourceId) && !(desktop && ['baidu', 'quark'].includes(requestedSourceId))) {
        return jsonReply(res, 400, { error: '无效的曲目筛选条件。' })
      }
      // The Web library exposes only local tracks, including random selections.
      const sourceId = desktop ? requestedSourceId : 'local'
      const randomParam = url.searchParams.get('random')
      if (randomParam !== null) {
        const count = Number(randomParam)
        if (!Number.isInteger(count) || count < 1 || count > RANDOM_PLAY_MAX) {
          return jsonReply(res, 400, { error: `无效的随机曲目数量（1-${RANDOM_PLAY_MAX}）。` })
        }
        const sample = randomLibrarySample(ctx.library, sourceId, count)
        return jsonReply(res, 200, { tracks: sample.tracks, total: sample.total, offset: 0, limit: count })
      }
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        return jsonReply(res, 400, { error: '无效的曲目筛选条件。' })
      }
      const identifiedParam = url.searchParams.get('identified') ?? 'all'
      if (!['all', 'identified', 'unidentified'].includes(identifiedParam)) {
        return jsonReply(res, 400, { error: '无效的识别状态筛选条件。' })
      }
      return jsonReply(res, 200, ctx.library.listTracksPage(sourceId, offset, limit,
        url.searchParams.get('q') ?? '', identifiedParam as 'all' | 'identified' | 'unidentified'))
    }
    const identifyMatch = /^\/tracks\/([0-9a-f-]{36})\/identify$/i.exec(path)
    if (identifyMatch && method === 'GET') {
      const track = ctx.library.getTrackDetail(identifyMatch[1])
      if (!track || (!desktop && track.sourceId !== 'local')) return jsonReply(res, 404, { error: '曲目不存在。' })
      try {
        if (desktop) return jsonReply(res, 200, await lookupDesktopTrack(track))
        const file = await validateLocalTrackFile(track.path)
        return jsonReply(res, 200, await lookupMusicBrainz(file.path, track.title, track.artist))
      } catch (error) {
        return jsonReply(res, error instanceof LocalTrackFileError ? error.statusCode : 502, {
          error: error instanceof Error ? error.message : '曲目识别失败。'
        })
      }
    }
    const trackMatch = /^\/tracks\/([0-9a-f-]{36})(\/audio)?$/i.exec(path)
    if (trackMatch) {
      const track = ctx.library.getTrackDetail(trackMatch[1])
      if (!track || (!desktop && track.sourceId !== 'local')) return jsonReply(res, 404, { error: '曲目不存在。' })
      if (!desktop && trackMatch[2] && read) {
        return await serveWebAudio(req, res, request => streamLocalAudio(track.path, request), audioContentType(track.path))
      }
      if (!trackMatch[2] && method === 'GET') return jsonReply(res, 200, track)
      if (!trackMatch[2] && method === 'PATCH') {
        try {
          const body = (await readJsonBody(req, 16 * 1024)) as Record<string, unknown> | null
          const identification = parseIdentification(body?.identification)
          if (identification) {
            return jsonReply(res, 200, ctx.library.applyIdentification(track.id, identification))
          }
          if (!body || typeof body.title !== 'string' ||
              (body.artist !== null && typeof body.artist !== 'string')) {
            return jsonReply(res, 400, { error: '标题必须是字符串，艺术家必须是字符串或 null。' })
          }
          const input: TrackEditInput = { title: body.title, artist: body.artist }
          const updated = await ctx.library.updateLocalTrack(track.id, input)
          return jsonReply(res, 200, updated)
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            return jsonReply(res, 413, { error: '请求体不能超过 16 KiB。' })
          }
          if (error instanceof Error && error.message === 'Invalid JSON body') {
            return jsonReply(res, 400, { error: 'Invalid JSON body' })
          }
          return jsonReply(res, localTrackMutationErrorStatus(error), {
            error: error instanceof Error ? error.message : '曲目更新失败。'
          })
        }
      }
      if (!trackMatch[2] && method === 'DELETE') {
        try {
          const deleted = await ctx.library.deleteLocalTrack(track.id)
          return jsonReply(res, 200, { ok: true, deleted: true, track: deleted })
        } catch (error) {
          return jsonReply(res, localTrackMutationErrorStatus(error), {
            error: error instanceof Error ? error.message : '曲目删除失败。'
          })
        }
      }
    }

    // GET /status
    if (method === 'GET' && path === '/status') {
      return jsonReply(res, 200, { ok: true, running: true, playback: playbackState, mode })
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
      res.once('close', () => eventSubscribers.delete(res))
      return
    }

    // GET /sources
    if (method === 'GET' && path === '/sources') {
      return jsonReply(res, 200, [
        { id: 'local', name: '本地音乐', type: 'local' },
        ...(desktop ? [
          { id: 'baidu', name: '百度网盘', type: 'baidu' },
          { id: 'quark', name: 'WebDAV 网盘', type: 'quark' }
        ] : [])
      ])
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
      if (!desktop) return jsonReply(res, 404, { error: '网页服务只支持自动扫描本地音乐目录。' })
      try {
        const { rootPath: syncedRoot, playlistId, scanned, added, updated, removed } = await desktop.resyncLibrary(rootPath)
        return jsonReply(res, 200, { rootPath: syncedRoot, playlistId, scanned, added, updated, removed })
      } catch (error) {
        return jsonReply(res, 404, { error: error instanceof Error ? error.message : '同步失败' })
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
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (!name) return jsonReply(res, 400, { error: '请输入歌单名称。' })
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

    if (method === 'POST' && ['/play', '/toggle-play', '/next', '/prev', '/shuffle', '/repeat', '/volume', '/seek'].includes(path)) {
      if (!desktop) return jsonReply(res, 409, { error: '网页端播放由当前浏览器控制。' })
      const reply = async (command: RemoteCommand, details = {}): Promise<void> => {
        if (!await desktop.sendCommand(command)) {
          return jsonReply(res, 503, { ok: false, error: '桌面播放器尚未就绪，未收到命令确认。' })
        }
        return jsonReply(res, 200, { ok: true, ...details })
      }
      const transport = {
        '/toggle-play': 'togglePlay', '/next': 'next', '/prev': 'prev', '/shuffle': 'shuffle', '/repeat': 'repeat'
      } as const
      const action = transport[path as keyof typeof transport]
      if (action) return await reply({ action })

      const body = await readJsonBody(req) as Record<string, unknown> | null
      if (path === '/volume') {
        if (typeof body?.volume !== 'number' || !Number.isFinite(body.volume)) {
          return jsonReply(res, 400, { error: 'Provide volume (0..1)' })
        }
        const volume = Math.max(0, Math.min(1, body.volume))
        return await reply({ action: 'setVolume', volume }, { volume })
      }
      if (path === '/seek') {
        const position = typeof body?.positionSec === 'number' ? body.positionSec :
          typeof body?.offsetSec === 'number' ? (playbackState?.positionSec ?? 0) + body.offsetSec : NaN
        if (!Number.isFinite(position)) return jsonReply(res, 400, { error: 'Provide positionSec or offsetSec' })
        const positionSec = Math.max(0, Math.min(playbackState?.durationSec || Infinity, position))
        return await reply({ action: 'seek', positionSec }, { positionSec })
      }
      if (typeof body?.playlistId === 'string' && body.playlistId) {
        const tracks = body.playlistId === '__favorites__'
          ? ctx.library.listFavoriteTracks() : ctx.library.listPlaylistTracks(body.playlistId)
        if (!tracks.length) return jsonReply(res, 404, { error: 'Playlist not found or empty' })
        const selected = body.mode === 'random20' ? pickRandomTracks(tracks, 20) : tracks
        return await reply({ action: 'play', tracks: selected }, { trackCount: selected.length })
      }
      if (typeof body?.trackId === 'string' && body.trackId) {
        const row = ctx.library.getTrackRow(body.trackId)
        if (!row) return jsonReply(res, 404, { error: 'Track not found' })
        const track = rowToTrack(row)
        return await reply({ action: 'playSingle', track }, { track })
      }
      if (typeof body?.query === 'string' && body.query.trim()) {
        const [track] = searchTracks(ctx, body.query, 1)
        if (!track) return jsonReply(res, 404, { error: 'No tracks found' })
        return await reply({ action: 'playSingle', track }, { track })
      }
      if (body && 'random' in body) {
        const count = body.random
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > RANDOM_PLAY_MAX) {
          return jsonReply(res, 400, { error: `无效的随机曲目数量（1-${RANDOM_PLAY_MAX}）。` })
        }
        const { tracks } = randomLibrarySample(ctx.library, 'all', count)
        if (!tracks.length) return jsonReply(res, 404, { error: 'No tracks found' })
        return await reply({ action: 'play', tracks }, { trackCount: tracks.length })
      }
      return jsonReply(res, 400, { error: 'Provide playlistId, trackId, query, or random' })
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

    // POST /download — download track audio to local disk
    if (method === 'POST' && path === '/download') {
      const body = (await readJsonBody(req)) as Record<string, unknown> | null
      const trackId = typeof body?.trackId === 'string' ? body.trackId : ''
      if (!trackId) return jsonReply(res, 400, { error: 'Missing trackId' })
      const dest = typeof body?.dest === 'string' ? body.dest : ''
      try {
        const result = await downloadTrack(ctx, trackId, dest)
        return jsonReply(res, 200, { ok: true, ...result })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Download failed'
        const notFound = message === '曲目不存在。'
        return jsonReply(res, notFound ? 404 : 500, { error: message })
      }
    }

    // GET /export — 歌单与收藏备份（JSON）
    if (method === 'GET' && path === '/export') {
      return jsonReply(res, 200, ctx.library.exportUserData())
    }

    // POST /import — body 为导出的备份 JSON
    if (method === 'POST' && path === '/import') {
      const body = (await readJsonBody(req)) as Record<string, unknown> | null
      if (!body || !Array.isArray(body.playlists) || !Array.isArray(body.favorites)) {
        return jsonReply(res, 400, { error: '无效的备份文件。' })
      }
      try {
        return jsonReply(res, 200, ctx.library.importUserData(body as never))
      } catch (error) {
        return jsonReply(res, 400, { error: error instanceof Error ? error.message : 'Import failed' })
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

    // 检索任务路由（两个前缀等价）：
    //   GET    /tasks               任务列表（全部运行中 + 最近 100 条已结束）
    //   GET    /tasks/:id/result    结果快照（原始检索结果）
    //   POST   /tasks/:id/cancel    取消运行中任务
    //   POST   /tasks/:id/retry     以原请求重新发起（新建任务记录）
    //   DELETE /tasks/:id           删除已结束任务（不影响已缓存歌曲信息）
    const songTaskMatch = path.match(/^(?:\/api\/music\/song-info|\/song-info)\/tasks(\/[^/]+(?:\/[^/]+)?)?$/)
    if (songTaskMatch) {
      const parts = (songTaskMatch[1] ?? '').split('/').filter(Boolean).map(decodeURIComponent)
      const [taskId, action] = parts

      if (method === 'GET' && parts.length === 0) {
        return jsonReply(res, 200, { tasks: ctx.songInfo.listTasks() })
      }
      if (method === 'POST' && parts.length === 0) {
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        if (typeof body?.trackId !== 'string' || !body.trackId) {
          return jsonReply(res, 400, { error: '请选择要检索的曲目。' })
        }
        if (!ctx.library.getTrackRow(body.trackId)) return jsonReply(res, 404, { error: '曲目不存在。' })
        return jsonReply(res, 202, ctx.songInfo.lookupTrack(body.trackId))
      }

      if (method === 'GET' && parts.length === 2 && action === 'result') {
        const result = ctx.songInfo.getTaskResult(taskId)
        if (result) return jsonReply(res, 200, result)
        const task = ctx.songInfo.getTask(taskId)
        return jsonReply(res, 404, { error: task ? '该任务没有结果。' : '任务不存在。' })
      }

      if (method === 'POST' && parts.length === 2 && action === 'cancel') {
        try {
          await ctx.songInfo.cancelTask(taskId)
          return jsonReply(res, 200, { ok: true, task: ctx.songInfo.getTask(taskId) })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Internal error'
          return jsonReply(res, taskErrorStatus(message), { error: message })
        }
      }

      if (method === 'POST' && parts.length === 2 && action === 'retry') {
        try {
          return jsonReply(res, 200, ctx.songInfo.retryTask(taskId))
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Internal error'
          return jsonReply(res, taskErrorStatus(message), { error: message })
        }
      }

      if (method === 'DELETE' && parts.length === 1) {
        try {
          ctx.songInfo.deleteTask(taskId)
          return jsonReply(res, 200, { ok: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Internal error'
          return jsonReply(res, taskErrorStatus(message), { error: message })
        }
      }
    }

    return jsonReply(res, 404, { error: 'Not found' })
  } catch (error) {
    if (res.destroyed) return
    if (res.headersSent) {
      res.destroy()
      return
    }
    const message = error instanceof Error ? error.message : 'Internal error'
    jsonReply(res, 500, { error: path.endsWith('/audio') ? '无法读取音频。' : message })
  }
}

export function startCliServer(ctx: CliServerContext): () => void {
  const portFile = join(ctx.endpointDir, 'cli-port')
  const tokenFile = join(ctx.endpointDir, 'cli-token')
  mkdirSync(ctx.endpointDir, { recursive: true, mode: 0o700 })
  removeEndpointFile(portFile)
  authToken = randomBytes(16).toString('hex')
  writeEndpointFile(tokenFile, authToken)

  const server = createServer((req, res) => {
    void handleRequest(ctx, req, res)
  })
  const stop = (): void => {
    authToken = null
    removeEndpointFile(portFile)
    removeEndpointFile(tokenFile)
    for (const res of eventSubscribers) res.end()
    eventSubscribers.clear()
    server.close()
    server.closeAllConnections()
  }
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      try {
        writeEndpointFile(portFile, String(addr.port))
        console.log(`[CLI] server listening on 127.0.0.1:${addr.port}`)
      } catch (error) {
        console.error('[CLI] endpoint file error:', error)
        stop()
      }
    }
  })
  server.on('error', error => {
    console.error('[CLI] server error:', error.message)
    stop()
  })
  return stop
}
