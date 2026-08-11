import { app, net, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { AiConfig, AiModelInfo, AiProtocol, AiTestResult } from '../shared/ipc'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const ANTHROPIC_VERSION = '2023-06-01'
const REQUEST_TIMEOUT_MS = 15_000

/** 按协议返回默认 base URL。 */
export function defaultBaseUrlFor(protocol: AiProtocol): string {
  return protocol === 'message' ? ANTHROPIC_BASE_URL : DEFAULT_BASE_URL
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

/**
 * 大模型接入配置与模型列表。
 * - 非敏感配置存 userData/ai-config.json
 * - API key 用 safeStorage 加密存 userData/credentials/ai-key.bin（与百度 token 一致）
 * - 模型列表端点：{baseUrl}/models，OpenAI 兼容用 Bearer，Anthropic 用 x-api-key
 */
export class AiService {
  private readonly configPath = join(app.getPath('userData'), 'ai-config.json')
  private readonly keyPath = join(app.getPath('userData'), 'credentials', 'ai-key.bin')

  getConfig(): AiConfig {
    let saved: Partial<AiConfig> = {}
    if (existsSync(this.configPath)) {
      try {
        saved = JSON.parse(readFileSync(this.configPath, 'utf-8')) as Partial<AiConfig>
      } catch {
        // 配置损坏时回退默认值
      }
    }
    return {
      protocol: saved.protocol === 'response' || saved.protocol === 'message' ? saved.protocol : 'chat',
      baseUrl: saved.baseUrl?.trim() ? normalizeBaseUrl(saved.baseUrl) : defaultBaseUrlFor(this.protocolOf(saved)),
      apiKey: '',
      hasApiKey: this.loadKey() !== null,
      model: saved.model ?? '',
      reasoningEffort: saved.reasoningEffort ?? ''
    }
  }

  private protocolOf(saved: Partial<AiConfig>): AiProtocol {
    return saved.protocol === 'response' || saved.protocol === 'message' ? saved.protocol : 'chat'
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
    const key = this.loadKey()
    if (!key) throw new Error('API Key 未设置，请先在 AI 设置中填写。')

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.protocol === 'message') {
      headers['x-api-key'] = key
      headers['anthropic-version'] = ANTHROPIC_VERSION
    } else {
      headers.Authorization = `Bearer ${key}`
    }

    let response: Response
    try {
      response = await net.fetch(`${config.baseUrl}/models`, {
        headers,
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
    try {
      const models = await this.fetchModels()
      return { ok: true, message: `✓ 连接成功 — ${models.length} 个模型可用` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}
