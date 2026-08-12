import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'
import {
  PLAYBACK_REMOTE_COMMAND_CHANNEL,
  type PlaybackState,
  type RemoteCommand,
  type Track
} from '../shared/ipc'
import type { LibraryService } from './library'
import type { LibrarySource } from '../shared/ipc'

const SOURCES: LibrarySource[] = [
  { id: 'local', name: '本地音乐', type: 'local' },
  { id: 'baidu', name: '百度网盘', type: 'baidu' },
  { id: 'quark', name: 'WebDAV 网盘', type: 'quark' }
]

interface CliServerContext {
  library: LibraryService
  getMainWindow: () => BrowserWindow | null
}

let server: Server | null = null
let playbackState: PlaybackState | null = null

export function setPlaybackState(state: PlaybackState | null): void {
  playbackState = state
}

function portFilePath(): string {
  return join(app.getPath('userData'), 'cli-port')
}

function writePortFile(port: number): void {
  writeFileSync(portFilePath(), String(port), 'utf8')
}

function removePortFile(): void {
  try {
    unlinkSync(portFilePath())
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

function sendRemoteCommand(ctx: CliServerContext, command: RemoteCommand): boolean {
  const win = ctx.getMainWindow()
  if (!win) return false
  win.webContents.send(PLAYBACK_REMOTE_COMMAND_CHANNEL, command)
  return true
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
    // GET /health
    if (method === 'GET' && path === '/health') {
      return jsonReply(res, 200, { ok: true })
    }

    // GET /playlists
    if (method === 'GET' && path === '/playlists') {
      const playlists = ctx.library.listPlaylists()
      return jsonReply(res, 200, playlists)
    }

    // GET /sources
    if (method === 'GET' && path === '/sources') {
      return jsonReply(res, 200, SOURCES)
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
        const tracks = ctx.library.listPlaylistTracks(String(body.playlistId))
        if (tracks.length === 0) {
          return jsonReply(res, 404, { error: 'Playlist not found or empty' })
        }
        const sent = sendRemoteCommand(ctx, { action: 'play', tracks })
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
        const sent = sendRemoteCommand(ctx, { action: 'playSingle', track })
        return jsonReply(res, 200, { ok: sent, track })
      }

      // search & play first result
      if (body.query) {
        const tracks = searchTracks(ctx, String(body.query), 1)
        if (tracks.length === 0) {
          return jsonReply(res, 404, { error: 'No tracks found' })
        }
        const sent = sendRemoteCommand(ctx, { action: 'playSingle', track: tracks[0] })
        return jsonReply(res, 200, { ok: sent, track: tracks[0] })
      }

      return jsonReply(res, 400, { error: 'Provide playlistId, trackId, or query' })
    }

    // POST /toggle-play
    if (method === 'POST' && path === '/toggle-play') {
      const sent = sendRemoteCommand(ctx, { action: 'togglePlay' })
      return jsonReply(res, 200, { ok: sent })
    }

    // POST /next
    if (method === 'POST' && path === '/next') {
      const sent = sendRemoteCommand(ctx, { action: 'next' })
      return jsonReply(res, 200, { ok: sent })
    }

    // POST /prev
    if (method === 'POST' && path === '/prev') {
      const sent = sendRemoteCommand(ctx, { action: 'prev' })
      return jsonReply(res, 200, { ok: sent })
    }

    // POST /shuffle
    if (method === 'POST' && path === '/shuffle') {
      const sent = sendRemoteCommand(ctx, { action: 'shuffle' })
      return jsonReply(res, 200, { ok: sent })
    }

    // POST /repeat
    if (method === 'POST' && path === '/repeat') {
      const sent = sendRemoteCommand(ctx, { action: 'repeat' })
      return jsonReply(res, 200, { ok: sent })
    }

    // GET /status
    if (method === 'GET' && path === '/status') {
      return jsonReply(res, 200, { ok: true, running: true, playback: playbackState })
    }

    return jsonReply(res, 404, { error: 'Not found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error'
    jsonReply(res, 500, { error: message })
  }
}

export function startCliServer(library: LibraryService, getMainWindow: () => BrowserWindow | null): void {
  const ctx: CliServerContext = { library, getMainWindow }

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
  if (server) {
    server.close()
    server = null
  }
}
