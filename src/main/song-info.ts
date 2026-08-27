import { basename, extname, join } from 'path'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager
} from '@earendil-works/pi-coding-agent'
import type { LibraryService, SongLyricsLine, SongMeta } from './library'

const DEFAULT_MODEL = 'qwen/qwen3.7-plus'
const AGENT_TIMEOUT_MS = 120_000
const PI_AGENT_DIR = getAgentDir()

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
  // 第一步：去除首尾空白
  let cleaned = text.trim()
  
  // 第二步：尝试直接解析
  try {
    return JSON.parse(cleaned)
  } catch {
    // 继续尝试其他方法
  }
  
  // 第三步：去除 markdown 代码块
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    // 继续尝试其他方法
  }
  
  // 第四步：截取首个 { 到末个 }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      // 继续尝试其他方法
    }
  }
  
  // 第五步：尝试找到所有 JSON 对象并提取第一个完整的
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
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const intro = asText(raw.intro)
  
  // 兼容 lyricsBilingual 和 lyrics 两个字段
  const lyricsSource = raw.lyricsBilingual ?? raw.lyrics
  
  const lines: SongLyricsLine[] = Array.isArray(lyricsSource)
    ? lyricsSource.flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const original = asText((item as Record<string, unknown>).original)
        const translated = asText((item as Record<string, unknown>).translated)
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

export class SongInfoService {
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
    
    // Try up to 2 times if web_search tool is reported as unavailable
    let result: SongInfoResult = {
      intro: '',
      lyrics: '',
      found: false,
      reason: '未执行查询'
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        result = await this.askAgent(trimmedPrompt, model)
        // If successful or if failure is not about web_search tool, break
        if (result.found || !result.reason?.includes('web_search')) {
          break
        }
        // Retry once when the web_search extension is unavailable.
      } catch (error) {
        result = {
          intro: '',
          lyrics: '',
          found: false,
          reason: error instanceof Error ? error.message : String(error)
        }
        break // Don't retry on exceptions
      }
    }
    
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
    const extensionPath = join(PI_AGENT_DIR, 'extensions', 'web-search', 'index.ts')

    const separator = modelName.indexOf('/')
    const provider = separator > 0 ? modelName.slice(0, separator) : 'qwen'
    const modelId = separator > 0 ? modelName.slice(separator + 1) : modelName
    const modelRuntime = await ModelRuntime.create({
      authPath: `${PI_AGENT_DIR}/auth.json`,
      modelsPath: `${PI_AGENT_DIR}/models.json`
    })
    const model = modelRuntime.getModel(provider, modelId)
    if (!model) throw new Error(`pi 未配置模型：${provider}/${modelId}`)

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: PI_AGENT_DIR,
      additionalExtensionPaths: [extensionPath]
    })
    
    await loader.reload()

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: PI_AGENT_DIR,
      modelRuntime,
      model,
      thinkingLevel: 'off',
      tools: ['web_search'],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory()
    })

    await session.bindExtensions({})

    let text = ''
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        text += event.assistantMessageEvent.delta
      }
    })
    let timeoutTimer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error('歌曲联网检索超时，请稍后重试。')), AGENT_TIMEOUT_MS)
    })
    try {
      await Promise.race([
        session.prompt(this.agentPrompt(prompt)),
        timeout
      ])
      if (!text.trim()) throw new Error('pi agent 未返回歌曲信息。')
      
      const parsed = parseJson(text)

      return normalizeResult(parsed)
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      unsubscribe()
      await session.abort().catch(() => undefined)
      session.dispose()
    }
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
