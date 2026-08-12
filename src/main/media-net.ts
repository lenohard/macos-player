import { createWriteStream } from 'fs'
import { unlink, rename } from 'fs/promises'
import { Readable } from 'stream'
import type { ReadableStream as NodeReadableStream } from 'stream/web'
import { pipeline } from 'stream/promises'
import { net } from 'electron'

/** Node/Electron HTTP headers must be ByteStrings (Latin-1). */
export function isAsciiHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) return false
  }
  return true
}

/** Outbound fetch for app-media proxy; never forwards renderer request headers. */
export async function downloadResponseToFile(response: Response, destination: string): Promise<void> {
  if (!response.ok) throw new Error(`下载请求失败（HTTP ${response.status}）`)
  if (!response.body) throw new Error('下载请求没有返回文件内容。')

  const temporaryPath = `${destination}.part`
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      createWriteStream(temporaryPath)
    )
    await rename(temporaryPath, destination)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

export function fetchWithElectronNet(
  url: string,
  headers: Record<string, string>
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', headers })
    req.on('response', res => {
      const outHeaders = new Headers()
      for (const key of Object.keys(res.headers)) {
        const raw = res.headers[key]
        if (raw === undefined) continue
        const val = Array.isArray(raw) ? raw.join(', ') : String(raw)
        if (!isAsciiHeaderValue(key) || !isAsciiHeaderValue(val)) continue
        try {
          outHeaders.set(key, val)
        } catch {
          // skip invalid header names/values
        }
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on('data', (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          })
          res.on('end', () => controller.close())
          res.on('error', (err: Error) => controller.error(err))
        },
        cancel() {
          req.abort()
        }
      })

      resolve(
        new Response(body, {
          status: res.statusCode && res.statusCode >= 200 ? res.statusCode : 502,
          headers: outHeaders
        })
      )
    })
    req.on('error', reject)
    req.end()
  })
}
