import { app, net, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import type { CloudEntry, WebDAVConfig, WebDAVStatus } from '../shared/ipc'

const configPath = () => join(app.getPath('userData'), 'credentials', 'webdav.bin')
let config: WebDAVConfig | null = null
function load(): WebDAVConfig | null {
  if (config) return config
  try {
    const raw = readFileSync(configPath())
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
    config = JSON.parse(text) as WebDAVConfig
    return config
  } catch { return null }
}
function baseUrl(): string {
  const value = load()?.url.trim() || ''
  return value.replace(/\/+$/, '')
}
function hrefPath(href: string): string {
  try { return decodeURIComponent(new URL(href, `${baseUrl()}/`).pathname) } catch { return href }
}
function joinPath(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl()}${clean === '/' ? '/' : clean}`
}
function headers(): Headers {
  const c = load(); const h = new Headers()
  if (c?.username) h.set('Authorization', `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`)
  return h
}
function xmlText(block: string, tag: string): string {
  const match = block.match(new RegExp(`<[^>]*${tag}[^>]*>([\\s\\S]*?)</[^>]*${tag}>`, 'i'))
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''
}
export class WebDAVService {
  getStatus(): WebDAVStatus {
    const c = load(); return { configured: !!c?.url, connected: false, url: c?.url || '', username: c?.username || '' }
  }
  saveConfig(next: WebDAVConfig): WebDAVStatus {
    let parsed: URL
    try { parsed = new URL(next.url) } catch { throw new Error('WebDAV URL 无效。') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('WebDAV URL 必须使用 HTTP(S)。')
    config = { url: next.url.trim(), username: next.username, password: next.password }
    const text = JSON.stringify(config); const raw = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text)
    mkdirSync(join(app.getPath('userData'), 'credentials'), { recursive: true }); writeFileSync(configPath(), raw)
    return this.getStatus()
  }
  async request(path: string, method: string, extra?: HeadersInit): Promise<Response> {
    if (!load()?.url) throw new Error('请先配置 WebDAV。')
    const h = headers()
    if (method === 'PROPFIND') h.set('Depth', '1')
    Object.entries(extra || {}).forEach(([k,v]) => h.set(k, String(v)))
    const response = await net.fetch(joinPath(path), { method, headers: h })
    // 207 = multistatus (PROPFIND), 416 = range not satisfiable (media seek); both are valid responses.
    if (!response.ok && response.status !== 207 && response.status !== 416) {
      throw new Error(`WebDAV 请求失败 (${response.status})`)
    }
    return response
  }
  async testConnection(): Promise<WebDAVStatus> {
    await this.request('/', 'PROPFIND'); return { ...this.getStatus(), connected: true }
  }
  async listDirectory(path: string): Promise<CloudEntry[]> {
    const response = await this.request(path || '/', 'PROPFIND'); const xml = await response.text(); const result: CloudEntry[] = []
    for (const block of xml.match(/<[^>]*response[\s\S]*?<\/[^>]*response>/gi) || []) {
      const href = xmlText(block, 'href'); const itemPath = hrefPath(href); if (itemPath.replace(/\/+$/, '') === (path || '/').replace(/\/+$/, '')) continue
      const resource = xmlText(block, 'resourcetype'); const isDirectory = /collection/i.test(resource)
      const name = decodeURIComponent(itemPath.split('/').filter(Boolean).pop() || '')
      const size = Number(xmlText(block, 'getcontentlength')) || 0
      const modified = Date.parse(xmlText(block, 'getlastmodified')) || 0
      result.push({ id: itemPath, name, path: itemPath, isDirectory, size, modifiedAt: modified })
    }
    return result
  }
  async stream(path: string, request: Request): Promise<Response> {
    const range = request.headers.get('Range'); const response = await this.request(path, 'GET', range ? { Range: range } : undefined)
    return response
  }
}
