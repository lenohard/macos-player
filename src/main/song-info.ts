import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import { DEFAULT_AI_MODEL } from '../shared/ai-defaults'
import type { SongInfoMeta, SongInfoTask, SongInfoToolStatus } from '../shared/ipc'
import type { LibraryService, SongLyricsLine, SongMeta } from './library'
import { SongInfoTaskManager } from './song-info-tasks'

// song-info 通过本地 pi-web 服务（https://github.com/agegr/pi-web）联网检索歌曲资料。
// corner 不内嵌 pi SDK、不存任何 key：模型/鉴权由 pi-web 侧统一（共享 ~/.pi/agent）。
// 服务地址和默认模型从 AiConfig 读取（用户可在 AI 设置页配置）。

const AGENT_TIMEOUT_MS = 240_000
// 取消时中断远端会话的有界超时
const REMOTE_ABORT_TIMEOUT_MS = 5000
// 取消时尚未拿到 sessionId 时，等待会话建立的宽限期
const SESSION_WAIT_MS = 3000
const CANCEL_MESSAGE = '已取消'
const CANNOT_CONFIRM_REMOTE_MESSAGE = '已取消本地任务，但无法确认远端已停止。'
// cwd 属于 pi-web 服务端，不能使用客户端本机路径；检索会话使用服务端临时目录。
const PI_WEB_SESSION_CWD = '/tmp'
type ConfigGetter = () => { piWebUrl: string; defaultModel: string; songInfoPrompt?: string }

// 内置默认提示词：不限制搜索次数，明确最终单行 JSON 输出格式与字段要求（程序按此解析入库）。
const DEFAULT_SONG_INFO_PROMPT = [
  '你是歌曲资料检索助手。',
  '',
  '【检索要求】',
  '1. 必须使用 web_search 工具联网搜索，禁止仅凭记忆回答',
  '2. 搜索次数不限：按需多次搜索，直到拿到歌曲介绍和完整歌词（建议分别搜「介绍」和「歌词」，用歌曲本身语言的关键词）',
  '3. 外语歌曲尽量再搜索歌词的中文翻译',
  '4. 歌词原文（lyrics / lyricsBilingual 的 original）必须从搜索或 API 返回的歌词文本中逐字复制：保留所有空格、标点与大小写，严禁凭记忆背诵、改写、合并或丢失单词间的空格',
  '',
  '【最终输出格式 — 程序按此解析入库，极其重要】',
  '全部搜索完成后，只输出一行 JSON：无解释、无前后缀、无 Markdown 代码围栏。字段固定为：',
  '{"found":true,"title":"歌曲标题","artist":"艺术家","intro":"歌曲介绍","lyrics":"完整歌词","lyricsBilingual":[],"reason":""}',
  '- found (boolean)：是否成功找到歌曲信息',
  '- title (string)：歌曲标题（检索到的官方/通行写法）；无法确认时返回空字符串，禁止编造',
  '- artist (string)：艺术家/歌手名；无法确认时返回空字符串，禁止编造',
  '- intro (string)：歌曲介绍（背景、歌手、专辑等）；无则空字符串',
  '- lyrics (string)：完整歌词，行间用 \\n 分隔（中文歌曲用此字段）',
  '- lyricsBilingual (array)：外语歌曲逐行 {"original":"原文","translated":"中文翻译"}；中文歌曲为空数组',
  '- reason (string)：found=false 时填具体原因；true 时为空字符串',
  '',
  '无法确认歌曲或歌词时返回 {"found":false,"title":"","artist":"","intro":"","lyrics":"","lyricsBilingual":[],"reason":"具体原因"}。',
  '',
  '用户请求：{query}'
].join('\n')

// 自定义提示词同样必须带上 title/artist：程序按固定字段解析，缺字段就无法补全曲目标题与艺术家。
const CUSTOM_PROMPT_META_SUFFIX = [
  '',
  '【附加输出要求 — 程序按此解析入库，必须遵守】',
  '最终输出的那行 JSON 除上述字段外，必须额外包含 title 与 artist 两个字符串字段：',
  '{"found":true,"title":"歌曲标题","artist":"艺术家/歌手名",…其余字段照旧}',
  '- 仅在确认检索到的就是这首歌时填写；无法确认或查不到时返回空字符串 ""，禁止编造或猜测。',
  '- found=false 时 title 与 artist 同样必须存在且为空字符串。'
].join('\n')

function piWebUnavailableError(base: string, detail: string): Error {
  return new SongInfoError(
    `pi-web 服务不可达（${base}）。请先运行 npx @agegr/pi-web 启动本地服务后重试。${detail ? ` 详情：${detail}` : ''}`,
    'network'
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function isNetworkError(error: unknown): boolean {
  // fetch 网络层失败（ECONNREFUSED / ENOTFOUND 等）由 undici 抛 TypeError('fetch failed')。
  // 原因在 cause，但形态不稳（有时带 code、有时 AggregateError、有时无 code），故以 TypeError 为准。
  return error instanceof TypeError
}

/** 用户取消：不落缓存、不写任务快照，不标记为失败。 */
class SongInfoCanceledError extends Error {
  constructor() {
    super('已取消。')
    this.name = 'SongInfoCanceledError'
  }
}

type SongInfoErrorKind = 'timeout' | 'model' | 'auth' | 'network' | 'other'

/** 带分类标签的错误：message 保持 REST/CLI 原始契约不变，任务摘要按 kind 归类为通用提示。 */
class SongInfoError extends Error {
  constructor(message: string, readonly kind: SongInfoErrorKind = 'other') {
    super(message)
    this.name = 'SongInfoError'
  }
}

/** 任务摘要消息：按错误分类给固定通用可操作提示，绝不落原始上游/诊断报文。 */
function taskErrorMessage(error: unknown): string {
  const kind = error instanceof SongInfoError ? error.kind : 'other'
  switch (kind) {
    case 'timeout':
      return '检索超时，请稍后重试。'
    case 'model':
      return '模型不可用，请在 AI 设置中更换模型后重试。'
    case 'auth':
      return 'pi-web 认证失败，请检查服务配置后重试。'
    case 'network':
      return '无法连接 pi-web。请检查大模型设置中的地址、网络和服务状态后重试。'
    default:
      return '检索失败，请稍后重试。'
  }
}

/** 检索发起时绑定的远端会话：base 不可变，取消后中断永远打原服务。 */
interface SessionRef {
  sessionId: string
  base: string
}

interface RunHandle {
  controller: AbortController
  canceled: boolean
  session: SessionRef | null
  sessionReady: Promise<SessionRef | null>
  resolveSession: (session: SessionRef | null) => void
  remoteStopped: boolean
}

function createRunHandle(): RunHandle {
  let resolveSession!: (session: SessionRef | null) => void
  const sessionReady = new Promise<SessionRef | null>(resolve => {
    resolveSession = resolve
  })
  return {
    controller: new AbortController(),
    canceled: false,
    session: null,
    sessionReady,
    resolveSession,
    remoteStopped: false
  }
}

/** 从 prompt 提取歌手（任务摘要展示用）。 */
function promptArtist(prompt: string): string | null {
  const match = prompt.match(/(?:歌手|演唱者|artist)\s*[:：]\s*([^\n；;|｜]+)/i)
  return match?.[1]?.trim() || null
}


export interface SongInfoResult {
  intro: string
  lyrics: string | SongLyricsLine[]
  /** 模型确认的标题/艺术家；缺失或无法确认时为空字符串（仅用于补全曲目元数据）。 */
  title: string
  artist: string
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

function asRawText(value: unknown): string {
  return typeof value === 'string' ? value : ''
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

  // 兼容 lyricsBilingual 和 lyrics 两个字段；空数组的 lyricsBilingual（如中文歌返回 []）不能吞掉 lyrics 原文，需回退到 lyrics
  const bilingual = Array.isArray(raw.lyricsBilingual) && raw.lyricsBilingual.length > 0 ? raw.lyricsBilingual : undefined
  const lyricsSource = bilingual ?? raw.lyrics

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
  if (!found) {
    return { intro: '', lyrics: '', title: '', artist: '', found: false, reason: asText(raw.reason) || '未找到可靠的歌曲信息或歌词。' }
  }
  return { intro, lyrics, title: asText(raw.title), artist: asText(raw.artist), found: true }
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
  try {
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
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// 从一条 message 类事件负载中提取 assistant 文本（兼容 text / content 字符串 / content 数组）。
function extractMessageText(payload: Record<string, unknown>): string {
  const message = asRecord(payload.message) ?? payload
  const role = asText(message.role)
  if (role && role !== 'assistant') return ''
  const direct = asRawText(message.text)
  if (direct) return direct
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        const entry = asRecord(part)
        return entry && entry.type === 'text' ? asRawText(entry.text) : ''
      })
      .filter(text => Boolean(text))
      .join('')
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
          cwd: PI_WEB_SESSION_CWD,
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
      // 401/403 归类为认证问题；其余创建失败归类为模型/参数不可用（message 保持原始契约）
      const kind = res.status === 401 || res.status === 403 ? 'auth' : 'model'
      throw new SongInfoError(`pi-web 会话创建失败：${detail || `HTTP ${res.status}`}`, kind)
    }
    const sessionId = asText(body.sessionId)
    if (!sessionId) throw new Error('pi-web 未返回 sessionId。')
    return sessionId
  }

  // Stream fragments to existing CLI consumers, but use the final assistant message for parsing.
  // Text emitted before a tool call may be progress narration, not part of the final JSON.
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
    let finalText = ''
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
        throw new SongInfoError(`pi-web 执行失败：${asText(payload.error ?? payload.message) || '未知错误'}`, 'other')
      }
      if (type === 'message_start' && asRecord(payload.message)?.role === 'assistant') {
        text = ''
        lastSent = ''
        finalText = ''
      }
      if (type === 'message_update') {
        const inner = asRecord(payload.assistantMessageEvent)
        const innerType = inner ? asText(inner.type) : ''
        if (innerType === 'text_delta' && inner) {
          // 流式 delta 绝不能 trim，否则会删除跨 SSE 分片的单词空格。
          const delta = asRawText(inner.delta)
          if (delta) {
            text += delta
            flush()
          }
        } else if (innerType === 'text_end' && inner) {
          // text_end.content 是当前文本块的权威内容，可修正流式拼接结果。
          const content = asRawText(inner.content)
          if (content && content.length > text.length) {
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
        const reason = asText(payload.stopReason ?? message?.stopReason)
        if (message?.role === 'assistant' && reason === 'toolUse') {
          // Keep CLI chunks already delivered, but discard pre-tool narration from final parsing.
          text = ''
          lastSent = ''
        } else if (message && (reason === 'endTurn' || reason === 'stop')) {
          finalText = extractMessageText(message) || text
          if (finalText.startsWith(text)) {
            text = finalText
            flush()
          }
        }
      } else if (type === 'prompt_done' || type === 'agent_end') {
        const completed = extractMessageText(payload)
        if (completed) {
          finalText = completed
          if (completed.startsWith(text)) { text = completed; flush() }
        }
        break
      }
    }
    return (finalText || text).trim()
  }

  // 中断远端会话（POST /api/agent/:id {type:'abort'}），有界超时。
  // base 必须用检索发起时捕获的地址（不可变），不读当前配置，避免中途改 piWebUrl 打错服务。
  // true = 可确认远端已停止（含会话已不存在/已回收）；false = 无法确认（网络不可达等）。
  async abortSession(base: string, sessionId: string): Promise<boolean> {
    try {
      const res = await fetch(`${base}/api/agent/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'abort' }),
        signal: AbortSignal.timeout(REMOTE_ABORT_TIMEOUT_MS)
      })
      if (res.status === 404) return true // 会话已被回收＝远端不再运行
      return res.ok
    } catch {
      return false
    }
  }

  // 流式问 agent：text 增量通过 onChunk 推送，函数 resolve 时返回完整文本。
  // options.signal：外部取消，本地立即中止；迟到结果由调用方丢弃，recover 不在取消路径执行。
  // options.onSession：会话建立后回调（已取消时也会回调，调用方据此真正中断远端）；
  // 携带本次检索发起时的 base，中断必须用它而非当前配置。
  // 会话创建只受超时约束：即使已取消也等它返回，拿到 sessionId 才能中断远端。
  async askStream(
    modelName: string,
    message: string,
    onChunk: (text: string) => void,
    onToolStatus?: (status: SongInfoToolStatus) => void,
    options?: { signal?: AbortSignal; onSession?: (sessionId: string, base: string) => void }
  ): Promise<string> {
    const base = this.piWebBaseUrl()
    const separator = modelName.indexOf(':')
    const provider = separator > 0 ? modelName.slice(0, separator) : 'opencode-go'
    const modelId = separator > 0 ? modelName.slice(separator + 1) : modelName

    const external = options?.signal
    if (external?.aborted) throw new SongInfoCanceledError()
    let canceled = false
    const deadline = new AbortController() // 仅超时约束（含会话创建）
    const run = new AbortController() // 流式订阅：超时或外部取消都会中止
    const onDeadline = (): void => run.abort()
    deadline.signal.addEventListener('abort', onDeadline, { once: true })
    const onExternalAbort = (): void => {
      canceled = true
      run.abort()
    }
    external?.addEventListener('abort', onExternalAbort, { once: true })
    const timeout = setTimeout(() => deadline.abort(), AGENT_TIMEOUT_MS)
    try {
      const sessionId = await this.createSession(base, provider, modelId, message, deadline.signal)
      options?.onSession?.(sessionId, base)
      if (canceled) throw new SongInfoCanceledError()
      let text = ''
      try {
        text = await this.streamAnswer(base, sessionId, run.signal, onChunk, onToolStatus)
      } catch (error) {
        if (canceled) throw new SongInfoCanceledError()
        if (!isAbortError(error)) throw error
      }
      if (canceled) throw new SongInfoCanceledError()
      if (!text) {
        if (deadline.signal.aborted) throw new SongInfoError('歌曲联网检索超时，请稍后重试。', 'timeout')
        text = await this.recoverAnswer(base, sessionId, run.signal)
      }
      if (!text) throw new Error('pi-web agent 未返回歌曲信息。')
      return text
    } catch (error) {
      if (canceled || error instanceof SongInfoCanceledError) throw new SongInfoCanceledError()
      if (isAbortError(error) || deadline.signal.aborted) throw new SongInfoError('歌曲联网检索超时，请稍后重试。', 'timeout')
      throw error
    } finally {
      clearTimeout(timeout)
      external?.removeEventListener('abort', onExternalAbort)
    }
  }

  // SSE 不重放事件：若未拿到最终文本（订阅晚于完成/断流），轮询会话状态，完成后读 sessionFile JSONL 取最后一段 assistant 文本。
  private async recoverAnswer(base: string, sessionId: string, signal: AbortSignal): Promise<string> {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (signal.aborted) return ''
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

}

interface SearchRequest {
  trackId: string | null
  prompt: string
  /** 原请求指定的模型；空 = 当前默认模型 */
  model: string
  overrides: Partial<PromptMetadata>
  artist: string | null
}

interface SearchCallbacks {
  onPartialText?: (text: string) => void
  onToolStatus?: (status: SongInfoToolStatus) => void
}

export class SongInfoService {
  private readonly agent: PiWebAgentClient
  private readonly tasks: SongInfoTaskManager
  private readonly running = new Map<string, RunHandle>()

  constructor(private readonly library: LibraryService, private readonly getConfig: ConfigGetter) {
    this.agent = new PiWebAgentClient(getConfig)
    this.tasks = new SongInfoTaskManager(library)
  }

  private getDefaultModel(): string {
    return this.getConfig().defaultModel || DEFAULT_AI_MODEL
  }

  get(identifier: string): SongMeta | null {
    return this.library.getSongMeta(identifier)
  }

  // ---- 任务 API（GUI IPC / CLI REST 共用） ----

  onTasksChanged(listener: () => void): () => void {
    return this.tasks.onTasksChanged(listener)
  }

  listTasks(): SongInfoTask[] {
    return this.tasks.list()
  }

  getTaskResult(id: string): SongInfoMeta | null {
    return this.tasks.getResult(id)
  }

  getTask(id: string): SongInfoTask | null {
    return this.tasks.get(id)
  }

  /** 删除已结束任务；不影响已缓存的歌曲信息。 */
  deleteTask(id: string): void {
    this.tasks.delete(id)
  }

  /** 取消：本地立即中止；远端经 pi-web abort 中断；无法确认远端停止时在任务提示中区分。 */
  async cancelTask(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) throw new Error('任务不存在。')
    const run = this.running.get(id)
    if (run) run.canceled = true
    // 先落终态（幂等）：此后迟到结果一律丢弃，不写缓存/快照
    const changed = this.tasks.cancel(id, CANCEL_MESSAGE)
    if (!changed || !run) return
    run.controller.abort()
    await this.stopRemote(id, run)
  }

  /** 以原请求重新发起（新建任务记录），使用当前默认模型；同曲目运行中任务去重。 */
  retryTask(id: string): { requestId: string } {
    const task = this.tasks.get(id)
    if (!task) throw new Error('任务不存在。')
    if (task.status === 'running') throw new Error('任务仍在进行中，无法重试。')
    const record = this.tasks.getRecord(id)
    if (!record) throw new Error('任务不存在。')
    if (record.track_id) return this.lookupTrack(record.track_id)
    const started = this.startSearch(
      {
        trackId: null,
        prompt: record.prompt,
        model: this.getDefaultModel(),
        overrides: { path: record.path, title: record.title, source: record.source },
        artist: record.artist
      },
      {}
    )
    void started.done.catch(() => undefined)
    return { requestId: started.requestId }
  }

  /** GUI：按曲目发起检索；同曲目已有运行中任务时返回同一 requestId。 */
  lookupTrack(trackId: string): { requestId: string } {
    const detail = this.library.getTrackDetail(trackId)
    if (!detail) throw new Error('曲目不存在。')
    const existing = this.tasks.findRunningByTrack(trackId)
    if (existing) return { requestId: existing.id }
    const prompt = [
      `歌曲名: ${detail.title}`,
      detail.artist ? `歌手: ${detail.artist}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    const started = this.startSearch(
      {
        trackId,
        prompt,
        model: this.getDefaultModel(),
        overrides: { path: detail.path, title: detail.title, source: detail.sourceId },
        artist: detail.artist
      },
      {}
    )
    void started.done.catch(() => undefined)
    return { requestId: started.requestId }
  }

  // ---- 检索执行（REST 兼容入口，响应语义不变） ----

  async lookup(
    prompt: string,
    modelId?: string,
    overrides?: Partial<PromptMetadata>
  ): Promise<SongMeta> {
    return this.startSearch(
      { trackId: null, prompt, model: modelId?.trim() || '', overrides: overrides ?? {}, artist: null },
      {}
    ).done
  }

  // 流式版 lookup：text 增量 → onPartialText（REST SSE 专用），完成时 upsert 并返回最终 SongMeta。
  async lookupStream(
    prompt: string,
    onPartialText: (text: string) => void,
    modelId?: string,
    overrides?: Partial<PromptMetadata>,
    onToolStatus?: (status: SongInfoToolStatus) => void
  ): Promise<SongMeta> {
    return this.startSearch(
      { trackId: null, prompt, model: modelId?.trim() || '', overrides: overrides ?? {}, artist: null },
      { onPartialText, onToolStatus }
    ).done
  }

  /** 建任务并执行；requestId 即任务 id，任务摘要记录本次实际使用的模型。 */
  private startSearch(
    request: SearchRequest,
    callbacks: SearchCallbacks
  ): { requestId: string; done: Promise<SongMeta> } {
    const trimmedPrompt = request.prompt.trim()
    if (!trimmedPrompt) throw new Error('prompt 不能为空。')
    const parsedMetadata = promptMetadata(trimmedPrompt)
    const metadata: PromptMetadata = {
      path: request.overrides.path?.trim() || parsedMetadata.path,
      title: request.overrides.title?.trim() || parsedMetadata.title,
      source: request.overrides.source?.trim() || parsedMetadata.source
    }
    const model = request.model || this.getDefaultModel()
    const task = this.tasks.create({
      trackId: request.trackId,
      prompt: trimmedPrompt,
      path: metadata.path,
      title: metadata.title,
      artist: request.artist ?? promptArtist(trimmedPrompt),
      source: metadata.source,
      model
    })
    const run = createRunHandle()
    this.running.set(task.id, run)
    const done = this.execute(task.id, request.trackId, run, trimmedPrompt, model, metadata, callbacks).finally(() => {
      this.running.delete(task.id)
    })
    return { requestId: task.id, done }
  }

  private async execute(
    taskId: string,
    trackId: string | null,
    run: RunHandle,
    prompt: string,
    model: string,
    metadata: PromptMetadata,
    callbacks: SearchCallbacks
  ): Promise<SongMeta> {
    try {
      const text = await this.agent.askStream(
        model,
        this.agentPrompt(prompt),
        chunk => callbacks.onPartialText?.(chunk),
        status => {
          this.tasks.updateProgress(taskId, status.toolCallCount, status.currentTool || null)
          callbacks.onToolStatus?.(status)
        },
        {
          signal: run.controller.signal,
          onSession: (sessionId, base) => {
            run.session = { sessionId, base }
            run.resolveSession(run.session)
            if (run.canceled) void this.stopRemote(taskId, run)
          }
        }
      )
      if (run.canceled) {
        // 取消后到达的迟到结果：不写缓存、不落快照。
        // 判定以 run 内存态为准：任务行可能已被删除，不能查 DB 状态
        throw new SongInfoCanceledError()
      }
      const result = normalizeResult(parseJson(text))
      const meta = this.library.upsertSongMeta({
        ...metadata,
        intro: result.intro,
        lyrics: lyricsText(result.lyrics),
        lyricsBilingual: bilingualLines(result.lyrics),
        model,
        found: result.found,
        reason: result.reason
      })
      if (trackId && result.found) {
        // 同一次检索结果顺带补全曲目标题/艺术家（仅本地曲目，条件写入见 LibraryService）；
        // 补全失败不影响已保存的歌曲资料与任务结果。
        try {
          this.library.fillTrackMetaFromAi(trackId, result.title, result.artist)
        } catch (error) {
          // 歌词已保存，但保留诊断信息以便排查元数据补全失败。
          console.error('[song-info] Failed to update track metadata:', error)
        }
      }
      this.tasks.complete(
        taskId,
        meta,
        result.found ? 'succeeded' : 'not_found',
        result.found ? null : '未找到歌曲信息。' // 摘要只写固定通用提示，具体原因仅保留在结果快照/响应中
      )
      return meta
    } catch (error) {
      // 取消判定以 run 内存态为准（任务行可能已被删除）；失败摘要只写分类通用提示
      if (error instanceof SongInfoCanceledError || run.canceled) {
        throw new SongInfoCanceledError()
      }
      this.tasks.fail(taskId, taskErrorMessage(error))
      throw error
    }
  }

  // 取消后中断远端会话；无法确认停止时在任务提示里区分。每 run 只真正中断一次。
  private async stopRemote(taskId: string, run: RunHandle): Promise<void> {
    const session =
      run.session ?? (await Promise.race([run.sessionReady, sleep(SESSION_WAIT_MS).then(() => null)]))
    if (run.remoteStopped) return
    if (!session) {
      // 会话迟迟未建立：如实标注无法确认；会话一旦建立由 onSession 补发中断
      this.tasks.setMessage(taskId, CANNOT_CONFIRM_REMOTE_MESSAGE)
      return
    }
    run.remoteStopped = true
    // 中断打检索发起时捕获的 base（不可变），中途改 piWebUrl 不影响
    const confirmed = await this.agent.abortSession(session.base, session.sessionId)
    this.tasks.setMessage(taskId, confirmed ? CANCEL_MESSAGE : CANNOT_CONFIRM_REMOTE_MESSAGE)
  }

  private agentPrompt(prompt: string): string {
    const custom = this.getConfig().songInfoPrompt?.trim()
    if (custom) {
      // 自定义提示词：支持 {query} 占位符；未提供时把用户请求追加到末尾。
      // 末尾再补固定的 title/artist 输出要求，保证入库字段完整。
      const body = custom.includes('{query}')
        ? custom.split('{query}').join(prompt)
        : `${custom}\n\n用户请求：${prompt}`
      return `${body}${CUSTOM_PROMPT_META_SUFFIX}`
    }
    return DEFAULT_SONG_INFO_PROMPT.split('{query}').join(prompt)
  }
}
