import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import type { LibraryService, SongLyricsLine, SongMeta } from './library'

// song-info 通过本地 pi-web 服务（https://github.com/agegr/pi-web）联网检索歌曲资料。
// corner 不内嵌 pi SDK、不存任何 key：模型/鉴权由 pi-web 侧统一（共享 ~/.pi/agent）。
// 服务地址默认 http://127.0.0.1:8964（launchd 常驻），可用环境变量 PI_WEB_URL 覆盖；不可达直接报错，不做降级。

const DEFAULT_MODEL = 'qwen/qwen3.7-plus'
const AGENT_TIMEOUT_MS = 240_000

function piWebBaseUrl(): string {
  return (process.env.PI_WEB_URL?.trim() || 'http://127.0.0.1:8964').replace(/\/+$/, '')
}

function piWebUnavailableError(base: string, detail: string): Error {
  return new Error(`pi-web 服务不可达（${base}）。请先运行 npx @agegr/pi-web 启动本地服务后重试。${detail ? ` 详情：${detail}` : ''}`)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function isNetworkError(error: unknown): boolean {
  // fetch 网络层失败（ECONNREFUSED / ENOTFOUND 等）抛 TypeError，原因在 cause.code
  return error instanceof TypeError && Boolean((error as { cause?: { code?: string } }).cause?.code)
}

export interface SongInfoResult {
  intro: string
  lyrics: string | SongLyricsLine[]
  found: boolean
  reason?: string
}

interface PromptMetadata {
  path: string
  title: string
  source: string
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function promptMetadata(prompt: string): PromptMetadata {
  const pathMatch = prompt.match(/\/[^^\s"'，。；;）)】】]+/)
  const path = pathMatch?.[0]?.replace(/[，。；;）)】】]+$/, '') ?? ''
  const beforePath = path ? prompt.slice(0, prompt.indexOf(path)).trim() : prompt.trim()
  const labeled = beforePath.match(/(?:歌曲名|歌名|song(?:\s+name)?|title)\s*[:：]\s*([^；;\n|｜]+)/i)
  const head = (labeled?.[1] ?? beforePath).replace(/[|｜]+/g, ' ').trim()
  const parts = head.split(/\s+[-–—]\s+/).map(part => part.trim()).filter(Boolean)
  const fromText = parts.length > 1 ? parts[parts.length - 1] : head
  const filename = path ? basename(path, extname(path)) : ''
  const title = fromText || filename || path || '未知歌曲'
  const source = /百度|baidu/i.test(prompt)
    ? 'baidu'
    : /夸克|quark|webdav/i.test(prompt)
      ? 'quark'
      : /本地|local|\/Volumes\//i.test(prompt)
        ? 'local'
        : ''
  return { path: path || title, title, source }
}

function parseJson(text: string): unknown {
  let cleaned = text.trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // 继续尝试其他方法
  }
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    // 继续尝试其他方法
  }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      // 继续尝试其他方法
    }
  }
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0])
    } catch {
      // 继续尝试其他方法
    }
  }
  throw new Error('模型返回的不是有效 JSON。')
}

function normalizeResult(value: unknown): SongInfoResult {
  const raw = asRecord(value) ?? {}
  const intro = asText(raw.intro)

  // 兼容 lyricsBilingual 和 lyrics 两个字段
  const lyricsSource = raw.lyricsBilingual ?? raw.lyrics

  const lines: SongLyricsLine[] = Array.isArray(lyricsSource)
    ? lyricsSource.flatMap(item => {
        const entry = asRecord(item)
        if (!entry) return []
        const original = asText(entry.original)
        const translated = asText(entry.translated)
        return original || translated ? [{ original, translated }] : []
      })
    : []

  const lyrics = typeof lyricsSource === 'string' ? lyricsSource.trim() : lines
  const found = raw.found === true
  if (!found) return { intro: '', lyrics: '', found: false, reason: asText(raw.reason) || '未找到可靠的歌曲信息或歌词。' }
  return { intro, lyrics, found: true }
}

function lyricsText(lyrics: string | SongLyricsLine[]): string {
  if (typeof lyrics === 'string') return lyrics
  return lyrics.map(line => line.original).filter(Boolean).join('\n')
}

function bilingualLines(lyrics: string | SongLyricsLine[]): SongLyricsLine[] {
  return Array.isArray(lyrics) ? lyrics : []
}

interface SseEvent {
  name: string
  data: string
}

// 标准 SSE 解析：event:/data: 行，空行分帧；多行 data 以 \n 拼接。
async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let name = ''
  let dataLines: string[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (!line) {
        if (name || dataLines.length) {
          yield { name, data: dataLines.join('\n') }
          name = ''
          dataLines = []
        }
        continue
      }
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  if (name || dataLines.length) yield { name, data: dataLines.join('\n') }
}

// 从一条 message 类事件负载中提取 assistant 文本（兼容 text / content 字符串 / content 数组）。
function extractMessageText(payload: Record<string, unknown>): string {
  const message = asRecord(payload.message) ?? payload
  const role = asText(message.role)
  if (role && role !== 'assistant') return ''
  const direct = asText(message.text)
  if (direct) return direct
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map(part => {
        const entry = asRecord(part)
        return entry && entry.type === 'text' ? asText(entry.text) : ''
      })
      .filter(Boolean)
      .join('')
      .trim()
  }
  return ''
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class PiWebAgentClient {
  private async createSession(base: string, provider: string, modelId: string, message: string, signal: AbortSignal): Promise<string> {
    let res: Response
    try {
      res = await fetch(`${base}/api/agent/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cwd: process.cwd(),
          type: 'prompt',
          message,
          provider,
          modelId,
          thinkingLevel: 'off'
        }),
        signal
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      if (isNetworkError(error)) throw piWebUnavailableError(base, (error as Error).message)
      throw error
    }
    const body = asRecord(await res.json().catch(() => null))
    if (!res.ok || !body || body.success !== true) {
      const detail = body ? asText(body.error ?? body.message) : `HTTP ${res.status}`
      throw new Error(`pi-web 会话创建失败：${detail || `HTTP ${res.status}`}`)
    }
    const sessionId = asText(body.sessionId)
    if (!sessionId) throw new Error('pi-web 未返回 sessionId。')
    return sessionId
  }

  private async collectAnswer(base: string, sessionId: string, signal: AbortSignal): Promise<string> {
    let res: Response
    try {
      res = await fetch(`${base}/api/agent/${encodeURIComponent(sessionId)}/events`, {
        headers: { accept: 'text/event-stream' },
        signal
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      if (isNetworkError(error)) throw piWebUnavailableError(base, (error as Error).message)
      throw error
    }
    if (!res.ok || !res.body) throw piWebUnavailableError(base, `事件流 HTTP ${res.status}`)

    // 事件序列：connected → message_update(流式增量) → message_end(stopReason) → tool_execution_* → prompt_done(含最终 message) → agent_end。
    let text = ''
    for await (const event of readSseEvents(res.body)) {
      const payload = asRecord(tryParseJson(event.data))
      if (!payload) continue
      const type = event.name || asText(payload.type)
      if (type === 'prompt_error') {
        throw new Error(`pi-web 执行失败：${asText(payload.error ?? payload.message) || '未知错误'}`)
      }
      if (type === 'message_end') {
        const message = asRecord(payload.message)
        if (message && asText(payload.stopReason ?? message.stopReason) === 'endTurn') {
          text = extractMessageText(message) || text
        }
      } else if (type === 'prompt_done') {
        text = extractMessageText(payload) || text
        break
      } else if (type === 'agent_end') {
        break
      }
    }
    return text.trim()
  }

  // SSE 不重放事件：若未拿到最终文本（订阅晚于完成/断流），轮询会话状态，完成后读 sessionFile JSONL 取最后一段 assistant 文本。
  private async recoverAnswer(base: string, sessionId: string, signal: AbortSignal): Promise<string> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = await fetch(`${base}/api/agent/${encodeURIComponent(sessionId)}`, { signal }).catch(() => null)
      const body = asRecord(res && res.ok ? await res.json().catch(() => null) : null)
      const state = asRecord(body?.data) ?? body
      if (state && state.isStreaming !== true && state.isPromptRunning !== true) {
        const file = asText(state.sessionFile)
        return file ? this.readLastAssistantText(file) : ''
      }
      await sleep(2000)
    }
    return ''
  }

  private async readLastAssistantText(file: string): Promise<string> {
    const raw = await readFile(file, 'utf8')
    let text = ''
    for (const line of raw.split('\n')) {
      const entry = asRecord(tryParseJson(line))
      const message = asRecord(entry?.message)
      if (!message || asText(message.role) !== 'assistant') continue
      const extracted = extractMessageText(message)
      if (extracted) text = extracted
    }
    return text.trim()
  }

  async ask(modelName: string, message: string): Promise<string> {
    const base = piWebBaseUrl()
    const separator = modelName.indexOf('/')
    const provider = separator > 0 ? modelName.slice(0, separator) : 'qwen'
    const modelId = separator > 0 ? modelName.slice(separator + 1) : modelName

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS)
    try {
      // 注意：prompt 在会话创建时即开始执行，SSE 必须随后立即订阅，否则只能走 recoverAnswer。
      const sessionId = await this.createSession(base, provider, modelId, message, controller.signal)
      let text = await this.collectAnswer(base, sessionId, controller.signal)
      if (!text) text = await this.recoverAnswer(base, sessionId, controller.signal)
      if (!text) throw new Error('pi-web agent 未返回歌曲信息。')
      return text
    } catch (error) {
      if (isAbortError(error)) throw new Error('歌曲联网检索超时，请稍后重试。')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}

export class SongInfoService {
  private readonly agent = new PiWebAgentClient()

  constructor(private readonly library: LibraryService) {}

  async lookup(
    prompt: string,
    modelId?: string,
    overrides?: Partial<PromptMetadata>
  ): Promise<SongMeta> {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) throw new Error('prompt 不能为空。')
    const parsedMetadata = promptMetadata(trimmedPrompt)
    const metadata: PromptMetadata = {
      path: overrides?.path?.trim() || parsedMetadata.path,
      title: overrides?.title?.trim() || parsedMetadata.title,
      source: overrides?.source?.trim() || parsedMetadata.source
    }
    const model = modelId?.trim() || DEFAULT_MODEL
    const result = await this.askAgent(trimmedPrompt, model)

    return this.library.upsertSongMeta({
      ...metadata,
      intro: result.intro,
      lyrics: lyricsText(result.lyrics),
      lyricsBilingual: bilingualLines(result.lyrics),
      model,
      found: result.found,
      reason: result.reason
    })
  }

  get(identifier: string): SongMeta | null {
    return this.library.getSongMeta(identifier)
  }

  private async askAgent(prompt: string, modelName: string): Promise<SongInfoResult> {
    const text = await this.agent.ask(modelName, this.agentPrompt(prompt))
    return normalizeResult(parseJson(text))
  }

  private agentPrompt(prompt: string): string {
    const isChinese = /[\u4e00-\u9fa5]/.test(prompt)
    const introHint = isChinese 
      ? '搜索时使用"歌曲名 介绍 百科"等中文关键词'
      : '搜索时使用"song title introduction wiki"等英文关键词'
    const lyricsHint = isChinese 
      ? '搜索时使用"歌曲名 歌词"等中文关键词'
      : '搜索时使用"song title lyrics"等英文关键词'
    
    return [
      '你是歌曲资料检索助手。',
      '',
      '【强制要求】',
      '1. 必须调用 web_search 工具两次，禁止凭记忆回答',
      '2. 可用工具：web_search（联网搜索）',
      '3. 调用 web_search 前不要输出任何文字',
      '',
      '【工作流程 - 必须严格执行】',
      'Step 1: 调用 web_search 搜索歌曲介绍',
      `  - ${introHint}`,
      '  - 例如：web_search({ query: "青花瓷 介绍 百科" })',
      '  - 等待返回结果',
      '',
      'Step 2: 调用 web_search 搜索歌曲歌词',
      `  - ${lyricsHint}`,
      '  - 例如：web_search({ query: "青花瓷 歌词" })',
      '  - 等待返回结果',
      '',
      'Step 3: 从两次搜索结果中提取歌曲介绍和完整歌词',
      '',
      'Step 4: 输出最终 JSON 结果',
      '',
      `用户请求：${prompt}`,
      '',
      '【最终输出格式 - 极其重要】',
      '完成两次 web_search 后，最终只输出一行 JSON，不要任何解释、前后缀、Markdown 或代码围栏：',
      '{"found":true,"intro":"歌曲介绍","lyrics":"歌词字符串或双语数组","lyricsBilingual":[{"original":"原文","translated":"中文翻译"}],"reason":""}',
      '',
      '键必须为：found, intro, lyrics, lyricsBilingual, reason',
      '外语歌词使用 lyricsBilingual 数组，每行一个 {"original":"原文","translated":"中文翻译"}；中文歌词可用 lyrics 字符串。',
      '无法确认歌曲或歌词时返回 {"found":false,"intro":"","lyrics":"","lyricsBilingual":[],"reason":"具体原因"}。',
      '',
      '现在开始：先调用两次 web_search，然后只输出一行 JSON。'
    ].join('\n')
  }
}

export { DEFAULT_MODEL }
