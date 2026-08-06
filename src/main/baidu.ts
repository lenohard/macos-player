import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  app,
  BrowserWindow,
  net,
  safeStorage,
  type WebContentsWillNavigateEventParams
} from 'electron'
import type { BaiduAuthStatus, CloudEntry } from '../shared/ipc'
import { fetchWithElectronNet, isAsciiHeaderValue } from './media-net'

interface BaiduConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  scope: string
}

interface BaiduToken {
  accessToken: string
  expiresIn: number
  refreshToken: string | null
  scope: string | null
  receivedAt: number
}

interface BaiduTokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  error?: string
  error_description?: string
}

interface BaiduListEntry {
  fs_id: number
  path: string
  server_filename: string
  isdir: number
  size: number
  server_mtime: number
}

interface BaiduListResponse {
  errno?: number
  list?: BaiduListEntry[]
}

const AUTHORIZATION_ENDPOINT = 'https://openapi.baidu.com/oauth/2.0/authorize'
const TOKEN_ENDPOINT = 'https://openapi.baidu.com/oauth/2.0/token'
const FILE_ENDPOINT = 'https://pan.baidu.com/rest/2.0/xpan/file'
const DOWNLOAD_ENDPOINT = 'https://d.pcs.baidu.com/rest/2.0/pcs/file'

function loadConfig(): BaiduConfig | null {
  const clientId = process.env.BAIDU_CLIENT_ID?.trim()
  const clientSecret = process.env.BAIDU_CLIENT_SECRET?.trim()
  const redirectUri = process.env.BAIDU_REDIRECT_URI?.trim()

  if (!clientId || !clientSecret || !redirectUri) return null

  try {
    new URL(redirectUri)
  } catch {
    return null
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    scope: process.env.BAIDU_SCOPE?.trim() || 'basic,netdisk'
  }
}

function isCallback(candidate: URL, redirect: URL): boolean {
  return candidate.protocol === redirect.protocol
    && candidate.host === redirect.host
    && candidate.pathname === redirect.pathname
}

export class BaiduService {
  private readonly config = loadConfig()
  private token: BaiduToken | null | undefined

  async getStatus(): Promise<BaiduAuthStatus> {
    if (!this.config) return { configured: false, connected: false, expiresAt: null }

    try {
      const token = await this.getValidToken()
      return {
        configured: true,
        connected: true,
        expiresAt: token.receivedAt + token.expiresIn * 1000
      }
    } catch {
      return { configured: true, connected: false, expiresAt: null }
    }
  }

  async login(parent: BrowserWindow | null): Promise<BaiduAuthStatus> {
    const config = this.requireConfig()
    const state = randomUUID()
    const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT)
    authorizationUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scope,
      state,
      display: 'popup'
    }).toString()

    const code = await this.openAuthorizationWindow(authorizationUrl, state, parent)
    this.token = await this.exchangeToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri
    })
    this.saveToken(this.token)
    return this.getStatus()
  }

  async logout(): Promise<BaiduAuthStatus> {
    this.token = null
    const path = this.tokenPath
    if (existsSync(path)) rmSync(path)
    return {
      configured: this.config !== null,
      connected: false,
      expiresAt: null
    }
  }

  async listDirectory(path: string): Promise<CloudEntry[]> {
    const token = await this.getValidToken()
    const entries: CloudEntry[] = []
    const limit = 1000

    for (let start = 0; ; start += limit) {
      const url = new URL(FILE_ENDPOINT)
      url.search = new URLSearchParams({
        method: 'list',
        dir: path,
        start: String(start),
        limit: String(limit),
        access_token: token.accessToken
      }).toString()

      const response = await net.fetch(url.toString())
      const payload = await response.json() as BaiduListResponse
      if (!response.ok) throw new Error(`百度网盘请求失败（HTTP ${response.status}）`)
      if (payload.errno !== 0 || !Array.isArray(payload.list)) {
        throw new Error(`百度网盘接口错误（${payload.errno ?? '未知'}）`)
      }

      entries.push(...payload.list.map(entry => ({
        id: String(entry.fs_id),
        name: entry.server_filename,
        path: entry.path,
        isDirectory: entry.isdir === 1,
        size: entry.size,
        modifiedAt: entry.server_mtime * 1000
      })))

      if (payload.list.length < limit) break
    }

    return entries.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-CN', { sensitivity: 'base' })
    })
  }

  async stream(path: string, request: Request): Promise<Response> {
    const token = await this.getValidToken()
    const url = new URL(DOWNLOAD_ENDPOINT)
    url.search = new URLSearchParams({
      method: 'download',
      access_token: token.accessToken,
      path
    }).toString()

    const headers: Record<string, string> = { 'User-Agent': 'pan.baidu.com' }
    const range = request.headers.get('Range')
    if (range && isAsciiHeaderValue(range)) headers.Range = range
    return fetchWithElectronNet(url.toString(), headers)
  }

  private requireConfig(): BaiduConfig {
    if (!this.config) {
      throw new Error('缺少百度 OAuth 配置，请设置 BAIDU_CLIENT_ID、BAIDU_CLIENT_SECRET 和 BAIDU_REDIRECT_URI。')
    }
    return this.config
  }

  private async openAuthorizationWindow(
    authorizationUrl: URL,
    expectedState: string,
    parent: BrowserWindow | null
  ): Promise<string> {
    const config = this.requireConfig()
    const redirect = new URL(config.redirectUri)
    const authWindow = new BrowserWindow({
      width: 520,
      height: 680,
      parent: parent ?? undefined,
      modal: parent !== null,
      show: false,
      title: '登录百度网盘',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    authWindow.setMenuBarVisibility(false)
    authWindow.once('ready-to-show', () => authWindow.show())

    return new Promise<string>((resolve, reject) => {
      let settled = false

      const finish = (result: { code: string } | { error: Error }): void => {
        if (settled) return
        settled = true
        if (!authWindow.isDestroyed()) authWindow.destroy()
        if ('code' in result) resolve(result.code)
        else reject(result.error)
      }

      const inspectNavigation = (
        event: Electron.Event<WebContentsWillNavigateEventParams>,
        candidateUrl: string
      ): void => {
        let callback: URL
        try {
          callback = new URL(candidateUrl)
        } catch {
          return
        }
        if (!isCallback(callback, redirect)) return

        event.preventDefault()
        const returnedState = callback.searchParams.get('state')
        if (returnedState !== expectedState) {
          finish({ error: new Error('百度登录状态校验失败，请重试。') })
          return
        }

        const oauthError = callback.searchParams.get('error_description')
          ?? callback.searchParams.get('error')
        if (oauthError) {
          finish({ error: new Error(`百度登录失败：${oauthError}`) })
          return
        }

        const code = callback.searchParams.get('code')
        if (!code) {
          finish({ error: new Error('百度登录未返回授权码。') })
          return
        }
        finish({ code })
      }

      authWindow.webContents.on('will-redirect', inspectNavigation)
      authWindow.webContents.on('will-navigate', inspectNavigation)
      authWindow.once('closed', () => {
        if (!settled) finish({ error: new Error('已取消百度登录。') })
      })

      void authWindow.loadURL(authorizationUrl.toString()).catch(error => {
        finish({ error: new Error(`无法打开百度登录页：${String(error)}`) })
      })
    })
  }

  private async exchangeToken(parameters: Record<string, string>): Promise<BaiduToken> {
    const config = this.requireConfig()
    const response = await net.fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...parameters
      })
    })
    const payload = await response.json() as BaiduTokenResponse

    if (!response.ok || !payload.access_token || typeof payload.expires_in !== 'number') {
      throw new Error(payload.error_description ?? payload.error ?? `百度 token 请求失败（HTTP ${response.status}）`)
    }

    return {
      accessToken: payload.access_token,
      expiresIn: payload.expires_in,
      refreshToken: payload.refresh_token ?? null,
      scope: payload.scope ?? null,
      receivedAt: Date.now()
    }
  }

  private async getValidToken(): Promise<BaiduToken> {
    if (this.token === undefined) this.token = this.loadToken()
    if (!this.token) throw new Error('尚未登录百度网盘。')

    const expiresAt = this.token.receivedAt + this.token.expiresIn * 1000
    if (Date.now() < expiresAt - 60_000) return this.token
    if (!this.token.refreshToken) {
      await this.logout()
      throw new Error('百度登录已过期，请重新登录。')
    }

    try {
      this.token = await this.exchangeToken({
        grant_type: 'refresh_token',
        refresh_token: this.token.refreshToken
      })
      this.saveToken(this.token)
      return this.token
    } catch (error) {
      await this.logout()
      throw error
    }
  }

  private get tokenPath(): string {
    return join(app.getPath('userData'), 'credentials', 'baidu-token.bin')
  }

  private loadToken(): BaiduToken | null {
    const path = this.tokenPath
    if (!existsSync(path)) return null
    if (!safeStorage.isEncryptionAvailable()) return null

    try {
      return JSON.parse(safeStorage.decryptString(readFileSync(path))) as BaiduToken
    } catch {
      rmSync(path, { force: true })
      return null
    }
  }

  private saveToken(token: BaiduToken): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法保存百度登录。')
    }

    const path = this.tokenPath
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, safeStorage.encryptString(JSON.stringify(token)), { mode: 0o600 })
  }
}
