import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'

const renderer = join(__dirname, '../renderer')
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml'
}

export async function serveWebAsset(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const asset = pathname === '/web/' ? 'web.html' : pathname.slice('/web/'.length)
  if (!['web.html', 'corner-logo.png'].includes(asset) && !/^assets\/[\w-]+\.(?:js|css)$/.test(asset)) {
    res.writeHead(404).end()
    return
  }
  const file = join(renderer, asset)
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[extname(asset)],
    'Content-Length': info.size,
    'Cache-Control': asset.startsWith('assets/') ? 'private, max-age=31536000, immutable' : 'no-cache',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://coverartarchive.org https://archive.org https://*.archive.org; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff'
  })
  if (req.method === 'HEAD') res.end()
  else await pipeline(createReadStream(file), res)
}

export async function serveWebAudio(
  req: IncomingMessage,
  res: ServerResponse,
  load: (request: Request) => Promise<Response>,
  contentType?: string
): Promise<void> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  res.once('close', abort)
  try {
    const range = req.headers.range
    const response = await load(new Request('http://127.0.0.1/audio', {
      method: req.method,
      headers: range ? { Range: range } : undefined,
      signal: controller.signal
    }))
    if (res.destroyed || ![200, 206, 416].includes(response.status)) {
      await response.body?.cancel()
      if (!res.destroyed) res.writeHead(response.status === 404 ? 404 : 502).end()
      return
    }
    const headers: Record<string, string> = {
      'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff'
    }
    for (const name of ['Accept-Ranges', 'Content-Range', 'Content-Length', 'Content-Encoding']) {
      const value = response.headers.get(name)
      if (value) headers[name] = value
    }
    // Never serve a provider error page (or arbitrary upstream HTML) at the hub origin.
    const upstreamType = response.headers.get('Content-Type')
    if (upstreamType && /^(?:text\/|application\/(?:json|xml|xhtml\+xml))/i.test(upstreamType) && response.status !== 416) {
      await response.body?.cancel()
      res.writeHead(502).end()
      return
    }
    headers['Content-Type'] = contentType ?? (upstreamType?.startsWith('audio/') ? upstreamType : 'application/octet-stream')
    if (req.method === 'HEAD' || response.status === 416 || !response.body) {
      await response.body?.cancel()
      if (response.status === 416) delete headers['Content-Length']
      res.writeHead(response.status, headers).end()
      return
    }
    res.writeHead(response.status, headers)
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), res, {
      signal: controller.signal
    })
  } finally {
    res.off('close', abort)
  }
}
