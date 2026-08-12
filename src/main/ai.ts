import { app, net, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { AiConfig, AiModelInfo, AiProtocol, AiTestResult } from '../shared/ipc'

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'
const ANTHROPIC_VERSION = '2023-06-01'
const REQUEST_TIMEOUT_MS = 15_000

const ENDPOINT_PATHS: Record<AiProtocol, string> = {
  chat: '/chat/completions',
  response: '/responses',
  message: '/messages'
}

/** 返回默认 base URL。OpenCode Go 同时支持三种协议。 */
export function defaultBaseUrlFor(_protocol: AiProtocol): string {
  return DEFAULT_BASE_URL
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function providerFromId(id: string): string | undefined {
  const slash = id.indexOf('/')
  if (slash > 0) return id.slice(0, slash)
  return undefined
}

function parseModelItem(item: Record<string, unknown> & { id: string }): AiModelInfo {
  const provider =
    (typeof item.owned_by === 'string' && item.owned_by.trim() ? item.owned_by : undefined) ??
    providerFromId(item.id)

  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : undefined,
    provider
  }
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return key.slice(0, 2) + '••••'
  return key.slice(0, 4) + '••••' + key.slice(-4)
}

function containsTextReply(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.some(containsTextReply)
  if (!value || typeof value !== 'object') return false

  const record = value as Record<string, unknown>
  if (typeof record.text === 'string' && record.text.trim()) return true
  return containsTextReply(record.output_text) ||
    containsTextReply(record.content) ||
    containsTextReply(record.message) ||
    containsTextReply(record.output) ||
    containsTextReply(record.choices)
}

/**
 * 大模型接入配置与模型列表。
 * - 非敏感配置存 userData/ai-config.json
 * - API key 用 safeStorage 加密存 userData/credentials/ai-key.bin（与百度 token 一致）
 * - 模型列表端点：{baseUrl}/models（不需要 API Key）
 * - 模型测试按协议调用对应的文本生成端点，并使用安全存储中的 API Key
 */
export class AiService {
  private readonly configPath = join(app.getPath('userData'), 'ai-config.json')
  private readonly keyPath = join(app.getPath('userData'), 'credentials', 'ai-key.bin')

  /** 老默认值，读取时自动迁移到新默认 */
  private static readonly LEGACY_URLS = new Set([
    'https://api.openai.com/v1',
    'https://api.openai.com',
    'https://api.anthropic.com/v1',
    'https://api.anthropic.com'
  ])

  getConfig(): AiConfig {
    let saved: Partial<AiConfig> = {}
    if (existsSync(this.configPath)) {
      try {
        saved = JSON.parse(readFileSync(this.configPath, 'utf-8')) as Partial<AiConfig>
      } catch {
        // 配置损坏时回退默认值
      }
    }
    const rawKey = this.loadKey()
    const apiKeyMasked = rawKey ? maskApiKey(rawKey) : undefined
    const hasApiKey = rawKey !== null

    // 迁移老默认 URL → 新默认 (OpenCode Go)
    const savedBaseUrl = saved.baseUrl?.trim()
    const baseUrl = (!savedBaseUrl || AiService.LEGACY_URLS.has(savedBaseUrl))
      ? defaultBaseUrlFor(this.protocolOf(saved))
      : normalizeBaseUrl(savedBaseUrl)

    return {
      protocol: saved.protocol === 'response' || saved.protocol === 'message' ? saved.protocol : 'chat',
      baseUrl,
      apiKey: '',
      apiKeyMasked,
      hasApiKey,
      model: saved.model ?? '',
      reasoningEffort: saved.reasoningEffort ?? ''
    }
  }

  private protocolOf(saved: Partial<AiConfig>): AiProtocol {
    return saved.protocol === 'response' || saved.protocol === 'message' ? saved.protocol : 'chat'
  }

  revealApiKey(): string {
    return this.loadKey() ?? ''
  }

  saveConfig(config: AiConfig): AiConfig {
    const { apiKey, ...rest } = config
    const protocol = this.protocolOf(rest)
    const baseUrl = normalizeBaseUrl(rest.baseUrl || defaultBaseUrlFor(protocol))

    // 仅在提供了新 key 时写入；空串表示保留已有 key
    if (apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储不可用，无法保存 API Key。')
      }
      mkdirSync(dirname(this.keyPath), { recursive: true })
      writeFileSync(this.keyPath, safeStorage.encryptString(apiKey.trim()), { mode: 0o600 })
    }

    writeFileSync(
      this.configPath,
      JSON.stringify({ protocol, baseUrl, model: rest.model ?? '', reasoningEffort: rest.reasoningEffort ?? '' }, null, 2),
      { mode: 0o600 }
    )
    return this.getConfig()
  }

  private loadKey(): string | null {
    if (!existsSync(this.keyPath)) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(readFileSync(this.keyPath))
    } catch {
      rmSync(this.keyPath, { force: true })
      return null
    }
  }

  async fetchModels(): Promise<AiModelInfo[]> {
    const config = this.getConfig()

    // 模型目录是公开 GET 端点，不依赖 API Key；实际调用仍在测试连接时鉴权。
    let response: Response
    try {
      response = await net.fetch(`${config.baseUrl}/models`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      throw new Error(`网络请求失败：${error instanceof Error ? error.message : String(error)}`)
    }

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`HTTP ${response.status}${body ? `：${body.slice(0, 300)}` : ''}`)
    }

    const json = (await response.json()) as { data?: Array<Record<string, unknown>> }
    const items = (json.data ?? []).filter(item => typeof item.id === 'string') as Array<
      Record<string, unknown> & { id: string }
    >
    if (items.length === 0) throw new Error('响应中没有模型列表（data[].id）。')
    return items.sort((a, b) => a.id.localeCompare(b.id)).map(item => parseModelItem(item))
  }

  async testConnection(): Promise<AiTestResult> {
    const config = this.getConfig()
    const key = this.loadKey()
    if (!key) return { ok: false, message: 'API Key 未设置，请先填写并等待自动保存。' }
    if (!config.model.trim()) return { ok: false, message: '请先填写当前模型，再测试模型回复。' }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (config.protocol === 'message') {
      headers['x-api-key'] = key
      headers['anthropic-version'] = ANTHROPIC_VERSION
    } else {
      headers.Authorization = `Bearer ${key}`
    }

    const prompt = '请只回复：OK'
    const body = config.protocol === 'chat'
      ? { model: config.model.trim(), messages: [{ role: 'user', content: prompt }], max_tokens: 32 }
      : config.protocol === 'response'
        ? { model: config.model.trim(), input: prompt, max_output_tokens: 32, store: false }
        : { model: config.model.trim(), max_tokens: 32, messages: [{ role: 'user', content: prompt }] }

    let response: Response
    try {
      response = await net.fetch(`${config.baseUrl}${ENDPOINT_PATHS[config.protocol]}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      return { ok: false, message: `网络请求失败：${error instanceof Error ? error.message : String(error)}` }
    }

    const responseBody = await response.text()
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}${responseBody ? `：${responseBody.slice(0, 300)}` : ''}` }
    }

    try {
      const responseJson: unknown = JSON.parse(responseBody)
      if (!containsTextReply(responseJson)) {
        return { ok: false, message: '请求成功，但没有收到文本回复。' }
      }
    } catch {
      return { ok: false, message: '请求成功，但响应不是有效的 JSON。' }
    }

    return { ok: true, message: '✓ 模型回复正常' }
  }
}
