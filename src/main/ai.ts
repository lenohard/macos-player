import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AiConfig, AiModelInfo, AiTestResult } from '../shared/ipc'
import { DEFAULT_AI_MODEL, normalizePiWebUrl } from '../shared/ai-defaults'
import { getDataDir } from './data-path'

const REQUEST_TIMEOUT_MS = 15_000

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
 * - 连接测试也检查模型接口，避免首页可达却无法使用检索的误报
 */
export class AiService {
  private readonly configPath = join(getDataDir(), 'ai-config.json')

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
      piWebUrl: typeof saved?.piWebUrl === 'string' ? saved.piWebUrl : normalizePiWebUrl(''),
      defaultModel: typeof saved?.defaultModel === 'string' ? saved.defaultModel.trim() || DEFAULT_AI_MODEL : DEFAULT_AI_MODEL,
      songInfoPrompt: typeof saved?.songInfoPrompt === 'string' ? saved.songInfoPrompt.trim() : ''
    }
  }

  saveConfig(config: AiConfig): AiConfig {
    const piWebUrl = normalizePiWebUrl(config.piWebUrl)
    const defaultModel = config.defaultModel?.trim() || DEFAULT_AI_MODEL
    const songInfoPrompt = (config.songInfoPrompt ?? '').trim()
    writeFileSync(this.configPath, JSON.stringify({ piWebUrl, defaultModel, songInfoPrompt }, null, 2), { mode: 0o600 })
    return this.getConfig()
  }

  async fetchModels(piWebUrl = this.getConfig().piWebUrl): Promise<AiModelInfo[]> {
    const base = normalizePiWebUrl(piWebUrl)
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      // Match song-info's Node transport; Chromium's system proxy can misroute a Tailnet address.
      response = await fetch(`${base}/api/models`, { headers: { Accept: 'application/json' }, signal })
    } catch {
      throw new Error(signal.aborted ? 'PI_WEB_TIMEOUT' : 'PI_WEB_UNREACHABLE')
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if (response.status === 401 || response.status === 403) throw new Error('PI_WEB_DENIED')
      if (response.status === 404) throw new Error('PI_WEB_BAD_RESPONSE')
      throw new Error('PI_WEB_SERVICE_ERROR')
    }

    const json = await response.json().catch(() => null) as { modelList?: unknown[] } | null
    if (signal.aborted) throw new Error('PI_WEB_TIMEOUT')
    if (!Array.isArray(json?.modelList)) throw new Error('PI_WEB_BAD_RESPONSE')
    const items = json.modelList.filter((item): item is Record<string, unknown> & { id: string } =>
      item !== null && typeof item === 'object' && 'id' in item && typeof item.id === 'string' && item.id.length > 0
    )
    return items.sort((a, b) => a.id.localeCompare(b.id)).map(parseModelItem)
  }

  async testConnection(): Promise<AiTestResult> {
    try {
      const models = await this.fetchModels()
      return { ok: true, message: `连接正常，可用模型 ${models.length} 个。` }
    } catch {
      return { ok: false, message: '无法连接 pi-web，请检查服务地址和网络。' }
    }
  }
}
