import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import type { BaiduService } from './baidu'
import type { LibraryService } from './library'
import type { WebDAVService } from './webdav'

const AUDIO_TYPES: Record<string, string> = {
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav'
}

export function audioContentType(path: string): string | undefined {
  return AUDIO_TYPES[extname(path).toLowerCase()]
}

async function streamFile(path: string, type: string, request: Request): Promise<Response> {
  const file = await open(path, 'r').catch(() => null)
  if (!file) return new Response(null, { status: 404 })
  let handedOff = false
  try {
    const info = await file.stat()
    if (!info.isFile()) return new Response(null, { status: 404 })
    const { size } = info
    const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Type': type })
    const range = request.headers.get('range')
    let start = 0
    let end = size - 1
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
      if (match && (match[1] || match[2])) {
        if (match[1]) {
          start = Number(match[1])
          if (match[2]) end = Math.min(end, Number(match[2]))
        } else start = Math.max(0, size - Number(match[2]))
      }
      if (!match || !(match[1] || match[2]) || start >= size || end < start) {
        headers.set('Content-Range', `bytes */${size}`)
        return new Response(null, { status: 416, headers })
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    }
    headers.set('Content-Length', String(end - start + 1))
    const options = { status: range ? 206 : 200, headers }
    if (request.method === 'HEAD' || !size) return new Response(null, options)
    const stream = file.createReadStream({ start, end, signal: request.signal })
    const body = Readable.toWeb(stream, {
      strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength }
    }) as unknown as ReadableStream<Uint8Array>
    handedOff = true
    return new Response(body, options)
  } finally {
    if (!handedOff) await file.close()
  }
}

export function streamLocalAudio(path: string, request: Request): Promise<Response> {
  return streamFile(path, audioContentType(path) ?? 'application/octet-stream', request)
}

export async function streamTrack(
  library: LibraryService,
  baidu: BaiduService,
  webdav: WebDAVService,
  trackId: string,
  request: Request
): Promise<Response> {
  const source = library.resolveMedia(trackId)
  if (!source) return new Response(null, { status: 404 })
  if (source.kind === 'baidu') return baidu.stream(source.path, request)
  if (source.kind === 'webdav') return webdav.stream(source.path, request)
  return streamLocalAudio(source.path, request)
}
