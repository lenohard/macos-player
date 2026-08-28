import { app, net } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AiConfig, AiModelInfo, AiTestResult } from '../shared/ipc'

const REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_PI_WEB_URL = 'http://100.109.27.51:8964'
const DEFAULT_MODEL = 'opencode-go:qwen3.8-max'

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '') || DEFAULT_PI_WEB_URL
}

function providerFromId(id: string): string | undefined {
  const slash = id.indexOf('/')
  if (slash > 0) return id.slice(0, slash)
  return undefined
}

function parseModelItem(item: Record<string, unknown> & { id: string }): AiModelInfo {
  // 优先读 pi-web 实际返回的 provider 字段（qwen / opencode-go），其次 OpenAI 风格的 owned_by，最后从 id 推。
  const provider =
    (typeof item.provider === 'string' && item.provider.trim() ? item.provider : undefined) ??
    (typeof item.owned_by === 'string' && item.owned_by.trim() ? item.owned_by : undefined) ??
    providerFromId(item.id)
  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : undefined,
    provider
  }
}

/**
 * pi-web agent 配置：地址 + 默认模型。
 * - 配置存 userData/ai-config.json
 * - 模型列表从 {piWebUrl}/api/models 获取（字段名 modelList）
 * - 健康检查调 {piWebUrl} GET（仅需可达，不依赖 API Key）
 */
export class AiService {
  private readonly configPath = join(app.getPath('userData'), 'ai-config.json')

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
      piWebUrl: normalizeUrl(saved.piWebUrl ?? ''),
      defaultModel: saved.defaultModel?.trim() || DEFAULT_MODEL
    }
  }

  saveConfig(config: AiConfig): AiConfig {
    const piWebUrl = normalizeUrl(config.piWebUrl)
    const defaultModel = config.defaultModel?.trim() || DEFAULT_MODEL
    writeFileSync(this.configPath, JSON.stringify({ piWebUrl, defaultModel }, null, 2), { mode: 0o600 })
    return this.getConfig()
  }

  async fetchModels(): Promise<AiModelInfo[]> {
    const config = this.getConfig()
    let response: Response
    try {
      response = await net.fetch(`${config.piWebUrl}/api/models`, {
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

    const json = (await response.json()) as { modelList?: Array<Record<string, unknown>> }
    const items = (json.modelList ?? []).filter(item => typeof item.id === 'string') as Array<
      Record<string, unknown> & { id: string }
    >
    if (items.length === 0) throw new Error('响应中没有模型列表（modelList[].id）。')
    return items.sort((a, b) => a.id.localeCompare(b.id)).map(item => parseModelItem(item))
  }

  async testConnection(): Promise<AiTestResult> {
    const config = this.getConfig()
    try {
      const response = await net.fetch(config.piWebUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) {
        return { ok: false, message: `HTTP ${response.status}` }
      }
      return { ok: true, message: `✓ pi-web 连接正常（${config.piWebUrl}）` }
    } catch (error) {
      return { ok: false, message: `pi-web 连接失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}
