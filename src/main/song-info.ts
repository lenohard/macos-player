import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import type { LibraryService, SongLyricsLine, SongMeta } from './library'

// song-info 通过本地 pi-web 服务（https://github.com/agegr/pi-web）联网检索歌曲资料。
// corner 不内嵌 pi SDK、不存任何 key：模型/鉴权由 pi-web 侧统一（共享 ~/.pi/agent）。
// 服务地址和默认模型从 AiConfig 读取（用户可在 AI 设置页配置）。

const AGENT_TIMEOUT_MS = 240_000
type ConfigGetter = () => { piWebUrl: string; defaultModel: string; songInfoPrompt?: string }

// 内置默认提示词：不限制搜索次数，明确最终单行 JSON 输出格式与字段要求（程序按此解析入库）。
const DEFAULT_SONG_INFO_PROMPT = [
  '你是歌曲资料检索助手。',
  '',
  '【检索要求】',
  '1. 必须使用 web_search 工具联网搜索，禁止仅凭记忆回答',
  '2. 搜索次数不限：按需多次搜索，直到拿到歌曲介绍和完整歌词（建议分别搜「介绍」和「歌词」，用歌曲本身语言的关键词）',
  '3. 外语歌曲尽量再搜索歌词的中文翻译',
  '',
  '【最终输出格式 — 程序按此解析入库，极其重要】',
  '全部搜索完成后，只输出一行 JSON：无解释、无前后缀、无 Markdown 代码围栏。字段固定为：',
  '{"found":true,"intro":"歌曲介绍","lyrics":"完整歌词","lyricsBilingual":[],"reason":""}',
  '- found (boolean)：是否成功找到歌曲信息',
  '- intro (string)：歌曲介绍（背景、歌手、专辑等）；无则空字符串',
  '- lyrics (string)：完整歌词，行间用 \\n 分隔（中文歌曲用此字段）',
  '- lyricsBilingual (array)：外语歌曲逐行 {"original":"原文","translated":"中文翻译"}；中文歌曲为空数组',
  '- reason (string)：found=false 时填具体原因；true 时为空字符串',
  '',
  '无法确认歌曲或歌词时返回 {"found":false,"intro":"","lyrics":"","lyricsBilingual":[],"reason":"具体原因"}。',
  '',
  '用户请求：{query}'
].join('\n')

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
  constructor(private readonly getConfig: ConfigGetter) {}

  private piWebBaseUrl(): string {
    return this.getConfig().piWebUrl.replace(/\/+$/, '')
  }

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

  // 流式版 collectAnswer：订阅 pi-web 事件流，逐个 text_delta 累加并通过 onChunk 推送给调用方。
  // 事件流顺序：connected → message_update(text_delta) → text_end → message_end → prompt_done / agent_end。
  // 遇到 message_update 以外的 message / message_end 会拿到全量文本，补充覆盖以防丢字。
  // SSE 不可靠：若未拿到完整文本，调用方应继续走 recoverAnswer。
  // 流式版 collectAnswer：订阅 pi-web 事件流，逐个 text_delta 累加并通过 onChunk 推送给调用方。
  // 事件流顺序：connected → message_update(text_delta) → text_end → message_end → prompt_done / agent_end。
  // 遇到 message_update 以外的 message / message_end 会拿到全量文本，补充覆盖以防丢字。
  // SSE 不可靠：若未拿到完整文本，调用方应继续走 recoverAnswer。
  // onToolStatus 可选：每次工具状态变化时推一次快照（{toolCallCount, currentTool, toolCalls[]})。
  private async streamAnswer(
    base: string,
    sessionId: string,
    signal: AbortSignal,
    onChunk: (text: string) => void,
    onToolStatus?: (status: { toolCallCount: number; currentTool: string; toolCalls: Array<{ name: string; status: 'planning' | 'running' | 'done' }> }) => void
  ): Promise<string> {
    const res = await fetch(`${base}/api/agent/${encodeURIComponent(sessionId)}/events`, {
      headers: { accept: 'text/event-stream' },
      signal
    }).catch((error: unknown) => {
      if (isAbortError(error)) throw error
      if (isNetworkError(error)) throw piWebUnavailableError(base, (error as Error).message)
      throw error
    })
    if (!res.ok || !res.body) throw piWebUnavailableError(base, `事件流 HTTP ${res.status}`)

    let text = ''
    let lastSent = '' // 已通过 onChunk 推送过的累计文本
    const flush = (): void => {
      if (text.length > lastSent.length) {
        onChunk(text.slice(lastSent.length))
        lastSent = text
      }
    }
    // 工具状态跟踪：以 toolCallStart 计数，tool_execution_start 标记 running，tool_execution_end 标记 done。
    const toolCalls: Array<{ name: string; status: 'planning' | 'running' | 'done' }> = []
    const pushToolStatus = (): void => {
      if (!onToolStatus) return
      const last = toolCalls[toolCalls.length - 1]
      const currentTool = last && last.status !== 'done' ? last.name : ''
      onToolStatus({ toolCallCount: toolCalls.length, currentTool, toolCalls: toolCalls.map(t => ({ ...t })) })
    }

    for await (const event of readSseEvents(res.body)) {
      const payload = asRecord(tryParseJson(event.data))
      if (!payload) continue
      const type = event.name || asText(payload.type)
      if (type === 'prompt_error') {
        throw new Error(`pi-web 执行失败：${asText(payload.error ?? payload.message) || '未知错误'}`)
      }
      // text_delta 增量：assistantMessageEvent.delta 是片段，拼到 text 末尾后推送。
      if (type === 'message_update') {
        const inner = asRecord(payload.assistantMessageEvent)
        const innerType = inner ? asText(inner.type) : ''
        if (innerType === 'text_delta' && inner) {
          const delta = asText(inner.delta)
          if (delta) {
            text += delta
            flush()
          }
        } else if (innerType === 'text_end' && inner) {
          // text_end.content 是完整最终文本，用于纠正丢字（低优先级：若当前 text 已被增量填充，不覆盖；仅在 text 仍为空时补全）
          const content = asText(inner.content)
          if (content && !text) {
            text = content
            flush()
          }
        } else if (innerType === 'toolcall_start' && inner) {
          // 工具调用计划阶段：把该工具记为 planning
          const name = asText(inner.toolName) || asText(inner.name) || 'unknown'
          toolCalls.push({ name, status: 'planning' })
          pushToolStatus()
        } else if (innerType === 'toolcall_end' && inner) {
          // 计划阶段结束：如果还没有对应的 tool_execution_start，上一条还标 planning，跳到 running
          // （有些场景 toolcall_end 之后才有 tool_execution_start；这里用 running 作为过渡态，tool_execution_end 覆盖为 done）
          if (toolCalls.length && toolCalls[toolCalls.length - 1].status === 'planning') {
            toolCalls[toolCalls.length - 1].status = 'running'
            pushToolStatus()
          }
        }
        continue
      }
      if (type === 'tool_execution_start') {
        // 真实开始执行工具：若 planning 列表里最后一条匹配，更新为 running；否则追加
        const name = asText(payload.toolName ?? payload.name) || (toolCalls.length ? toolCalls[toolCalls.length - 1].name : 'unknown')
        if (toolCalls.length && toolCalls[toolCalls.length - 1].name === name && toolCalls[toolCalls.length - 1].status !== 'done') {
          toolCalls[toolCalls.length - 1].status = 'running'
        } else {
          toolCalls.push({ name, status: 'running' })
        }
        pushToolStatus()
        continue
      }
      if (type === 'tool_execution_end') {
        const name = asText(payload.toolName ?? payload.name)
        // 找到最近一个 name 匹配且未 done 的工具
        for (let i = toolCalls.length - 1; i >= 0; i--) {
          if ((!name || toolCalls[i].name === name) && toolCalls[i].status !== 'done') {
            toolCalls[i].status = 'done'
            pushToolStatus()
            break
          }
        }
        continue
      }
      if (type === 'message_end') {
        const message = asRecord(payload.message)
        if (message && asText(payload.stopReason ?? message.stopReason) === 'endTurn') {
          const finalText = extractMessageText(message)
          if (finalText && finalText.length > text.length) {
            text = finalText
            flush()
          }
        }
      } else if (type === 'prompt_done') {
        const finalText = extractMessageText(payload)
        if (finalText && finalText.length > text.length) {
          text = finalText
          flush()
        }
        break
      } else if (type === 'agent_end') {
        break
      }
    }
    if (text.length > lastSent.length) {
      onChunk(text.slice(lastSent.length))
    }
    return text.trim()
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
      const state = asRecord(body?.data) ?? asRecord(body?.state) ?? body
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

  // 流式问 agent：text 增量通过 onChunk 推送，函数 resolve 时返回完整文本。
  // onToolStatus 可选：每次工具状态变化时推一次快照。
  // 内部复用 streamAnswer + recoverAnswer 兜底。
  async askStream(
    modelName: string,
    message: string,
    onChunk: (text: string) => void,
    onToolStatus?: (status: { toolCallCount: number; currentTool: string; toolCalls: Array<{ name: string; status: 'planning' | 'running' | 'done' }> }) => void
  ): Promise<string> {
    const base = this.piWebBaseUrl()
    const separator = modelName.indexOf(':')
    const provider = separator > 0 ? modelName.slice(0, separator) : 'opencode-go'
    const modelId = separator > 0 ? modelName.slice(separator + 1) : modelName

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS)
    try {
      const sessionId = await this.createSession(base, provider, modelId, message, controller.signal)
      let text = ''
      try {
        text = await this.streamAnswer(base, sessionId, controller.signal, onChunk, onToolStatus)
      } catch (error) {
        if (!isAbortError(error)) throw error
      }
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

  async ask(modelName: string, message: string): Promise<string> {
    const base = this.piWebBaseUrl()
    const separator = modelName.indexOf(':')
    const provider = separator > 0 ? modelName.slice(0, separator) : 'opencode-go'
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
  private readonly agent: PiWebAgentClient

  constructor(private readonly library: LibraryService, private readonly getConfig: ConfigGetter) {
    this.agent = new PiWebAgentClient(getConfig)
  }

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
    const model = modelId?.trim() || this.getDefaultModel()
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

  private getDefaultModel(): string {
    return this.getConfig().defaultModel || 'opencode-go:qwen3.8-max'
  }

  get(identifier: string): SongMeta | null {
    return this.library.getSongMeta(identifier)
  }

  // 流式版 lookup：text 增量 → onPartialText(纯文本，未解析 JSON)，完成时 upsert 并 onResult(最终 SongMeta)。
  // onToolStatus 可选：每次工具状态变化时推一次快照。
  async lookupStream(
    prompt: string,
    onPartialText: (text: string) => void,
    modelId?: string,
    overrides?: Partial<PromptMetadata>,
    onToolStatus?: (status: { toolCallCount: number; currentTool: string; toolCalls: Array<{ name: string; status: 'planning' | 'running' | 'done' }> }) => void
  ): Promise<SongMeta> {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) throw new Error('prompt 不能为空。')
    const parsedMetadata = promptMetadata(trimmedPrompt)
    const metadata: PromptMetadata = {
      path: overrides?.path?.trim() || parsedMetadata.path,
      title: overrides?.title?.trim() || parsedMetadata.title,
      source: overrides?.source?.trim() || parsedMetadata.source
    }
    const model = modelId?.trim() || this.getDefaultModel()

    // 把 agent 的纯文本流去重后逐步推给上层（agent 可能输出很多中间 thinking 文本，仅推送"看起来像最终答案"的稳定段）。
    // 简化：直接逐字推送原始文本，让前端实时显示；解析失败时回退到整段解析。
    const text = await this.agent.askStream(
      model,
      this.agentPrompt(trimmedPrompt),
      chunk => { onPartialText(chunk) },
      onToolStatus
    )
    const result = normalizeResult(parseJson(text))
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

  private async askAgent(prompt: string, modelName: string): Promise<SongInfoResult> {
    const text = await this.agent.ask(modelName, this.agentPrompt(prompt))
    return normalizeResult(parseJson(text))
  }

  private agentPrompt(prompt: string): string {
    const custom = this.getConfig().songInfoPrompt?.trim()
    if (custom) {
      // 自定义提示词：支持 {query} 占位符；未提供时把用户请求追加到末尾
      return custom.includes('{query}')
        ? custom.split('{query}').join(prompt)
        : `${custom}\n\n用户请求：${prompt}`
    }
    return DEFAULT_SONG_INFO_PROMPT.split('{query}').join(prompt)
  }
}
