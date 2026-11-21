import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { get as httpsGet } from 'https'
import type { TrackDetail } from '../shared/ipc'
import { validateLocalTrackFile } from './local-track-file'

// MusicBrainz 单曲候选识别核心（只查询、只返回候选，不写库；候选须由用户在 UI 确认后再入库）。
// 直连 musicbrainz.org：本机代理对 MB 返回 503，必须走 node:https 直连（https 模块不读代理环境变量）。

export interface MusicBrainzCandidate {
  id: string
  title: string
  artist: string | null
  /** artist-credit 里的 MusicBrainz 艺术家 id（有时缺失）。 */
  artistId: string | null
  durationSec: number | null
  firstReleaseDate: string | null
  score: number
  album: string | null
  /** 专辑（release）的 MB id，用于取封面与跳转链接。 */
  releaseId: string | null
  /** Cover Art Archive 的正面图地址；由 releaseId 推出，可能没有封面。 */
  coverUrl: string | null
}

export interface MusicBrainzLookupResult {
  /** 本地文件时长（秒，取整）；ffprobe 不可用/探测失败时为 null，标题查询照常继续。 */
  localDurationSec: number | null
  /** 各查询合并去重后的最多 10 个候选（score 为 MB 原始分），供用户人工确认。 */
  candidates: MusicBrainzCandidate[]
}

// MB 要求匿名请求带「应用名/版本 (联系方式)」UA；改版本时同步更新。
const USER_AGENT = 'corner/0.0.27 (macos-player; https://github.com/lenohard/macos-player)'
const SEARCH_URL = 'https://musicbrainz.org/ws/2/recording/'
const REQUEST_TIMEOUT_MS = 15_000
// socket idle 超时之外的总绝对 deadline，防异常服务器长时间流式拖着
const REQUEST_DEADLINE_MS = 20_000
// 响应体上限（搜索结果 JSON 正常远小于此）
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const FFPROBE_TIMEOUT_MS = 8_000
// 匿名接口限速 ≤1 req/s，全局串行排队并保证间隔
const MIN_REQUEST_INTERVAL_MS = 1_100
// 排队等待上限：并发查找多时不让单个请求无限排队（HTTP 本身另有超时）
const QUEUE_WAIT_TIMEOUT_MS = 20_000
// MB 服务端瞬时繁忙会返回 503（curl 也会轮流命中），按官方建议稍候重试；次数封顶
const BUSY_RETRIES = 2
const BUSY_RETRY_DELAY_MS = 1_500
const SEARCH_LIMIT = 25
const MAX_CANDIDATES = 10
const MAX_QUERIES_PER_LOOKUP = 3
const FFPROBE_PATHS = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']

/**
 * 查询单曲的 MusicBrainz 候选。完整标题优先查询；标题含「歌名 - 歌手」等分隔符时
 * 一定再做双向拆分查询（完整文件名查询容易命中宽泛错误结果），多路结果合并去重。
 * 本地时长只作为排序信号（无时长/时长稍差的候选不被过滤）；score 保留 MB 原始分。
 * 错误以带中文说明的 Error 抛出；ffprobe 失败不算错误。
 */
export async function lookupMusicBrainz(
  path: string,
  title: string,
  artist: string | null
): Promise<MusicBrainzLookupResult> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error('MusicBrainz 查询失败：标题为空，无法构造查询。')

  const localDurationSec = await probeLocalDurationSec(path)

  const merged = new Map<string, MusicBrainzCandidate>()
  let lastError: unknown = null
  for (const variant of queryVariants(trimmed, artist)) {
    try {
      const candidates = await searchRecordings(buildQuery(variant.title, variant.artist))
      for (const candidate of candidates) {
        const prev = merged.get(candidate.id)
        if (!prev || candidate.score > prev.score) merged.set(candidate.id, candidate)
      }
    } catch (error) {
      lastError = error
      // Keep already retrieved candidates rather than losing them to a later outage.
      if (merged.size > 0) break
    }
  }
  if (lastError && merged.size === 0) throw lastError
  return { localDurationSec, candidates: rankCandidates([...merged.values()], localDurationSec) }
}

export async function lookupDesktopTrack(track: Pick<TrackDetail, 'path' | 'sourceId' | 'title' | 'artist'>): Promise<MusicBrainzLookupResult> {
  // Duration is only a ranking hint. Do not download cloud audio or make
  // desktop imports depend on the Web service's dedicated music root.
  const file = track.sourceId === 'local' ? await validateLocalTrackFile(track.path).catch(() => null) : null
  return lookupMusicBrainz(file?.path ?? '', track.title, track.artist)
}

// ---------- 本地时长探测（ffprobe，execFile 不走 shell，限时） ----------

async function probeLocalDurationSec(path: string): Promise<number | null> {
  if (!path) return null
  const bin = FFPROBE_PATHS.find(existsSync) ?? 'ffprobe'
  return probeWith(bin, path)
}

function probeWith(bin: string, path: string): Promise<number | null> {
  return new Promise(resolve => {
    execFile(
      bin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
      { timeout: FFPROBE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) return resolve(null)
        const sec = Number.parseFloat(String(stdout).trim())
        resolve(Number.isFinite(sec) && sec > 0 ? Math.round(sec) : null)
      }
    )
  })
}

// ---------- 查询构造（Lucene 清洗/转义，支持中文与文件名式标题） ----------

interface QueryParts {
  title: string
  artist: string | null
}

const AUDIO_EXT_RE = /\.(mp3|flac|m4a|aac|wav|aiff?|alac|ogg|opus|wma|ape|wv|mp4|mkv)$/i
const TRACK_NO_RE = /^\d{1,3}\s*[-.–—)_]\s+/

function cleanTitle(raw: string): string {
  return raw.replace(AUDIO_EXT_RE, '').trim()
}

function stripTrackNumber(title: string): string {
  return title.replace(TRACK_NO_RE, '').trim()
}

/** 「歌名 - 歌手」等文件名分隔（短横/全角短横/下划线），返回 [前段, 后段]。 */
function splitTitleArtist(title: string): [string, string] | null {
  const dash = title.match(/^(.+?)\s*[-–—－]\s*(.+)$/)
  const under = dash ? null : title.match(/^(.+?)_+(.+)$/)
  const a = (dash?.[1] ?? under?.[1])?.trim()
  const b = (dash?.[2] ?? under?.[2])?.trim()
  return a && b ? [a, b] : null
}

/**
 * 查询顺序：① 完整标题；② 有分隔符时双向拆分（歌名 - 歌手 / 歌手 - 歌名）都查并合并，
 * 不因完整查询有结果就跳过拆分（完整文件名查询常命中宽泛错误结果）；
 * 无分隔符时补一个去「01. 」曲目号前缀的回退。总数封顶 MAX_QUERIES_PER_LOOKUP。
 */
function queryVariants(rawTitle: string, artist: string | null): QueryParts[] {
  const variants: QueryParts[] = []
  const push = (title: string, artistName: string | null): void => {
    if (!title || variants.length >= MAX_QUERIES_PER_LOOKUP) return
    if (variants.some(v => v.title === title && v.artist === artistName)) return
    variants.push({ title, artist: artistName })
  }

  const title = cleanTitle(rawTitle)
  push(title, artist) // ① 完整标题
  const parts = splitTitleArtist(title)
  if (parts) {
    push(parts[0], artist ?? parts[1]) // ② 歌名 - 歌手
    push(parts[1], artist ?? parts[0]) // ③ 反向：文件名也可能是 歌手 - 歌名
  } else {
    push(stripTrackNumber(title), artist) // 无分隔符：去掉「01. 」曲目号前缀
  }
  return variants
}

/**
 * Lucene 短语转义：查询始终包在双引号内，引号内只需转义 `"` 与 `\`（其余字符为字面量）。
 * 用函数式 replacer，避免 `$&`/`$1` 之类的替换引用陷阱；UTF-8（含中文）经 encodeURIComponent 传输。
 */
function escapePhrase(value: string): string {
  return value.replace(/["\\]/g, ch => (ch === '"' ? '\\"' : '\\\\'))
}

function buildQuery(title: string, artist: string | null): string {
  const parts = [`recording:"${escapePhrase(title)}"`]
  if (artist) parts.push(`artist:"${escapePhrase(artist)}"`)
  return parts.join(' AND ')
}

// ---------- MusicBrainz 请求（直连 HTTPS，全局串行限速） ----------

let requestChain: Promise<void> = Promise.resolve()
let lastRequestStart = 0

/**
 * 全局串行排队，保证相邻请求间隔 ≥ MIN_REQUEST_INTERVAL_MS；
 * 排队等待超过 QUEUE_WAIT_TIMEOUT_MS 即放弃并报错，不让单个请求无限排队。
 */
function scheduleRequest<T>(task: () => Promise<T>): Promise<T> {
  let abandoned = false
  const result = requestChain.then(async () => {
    const wait = lastRequestStart + MIN_REQUEST_INTERVAL_MS - Date.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    if (abandoned) throw new Error('已放弃排队中的 MusicBrainz 请求。')
    lastRequestStart = Date.now()
    return task()
  })
  requestChain = result.then(
    () => undefined,
    () => undefined
  )
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abandoned = true
      reject(new Error('MusicBrainz 查询排队超时，请稍后重试。'))
    }, QUEUE_WAIT_TIMEOUT_MS)
    result.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

interface MbHttpError extends Error {
  mbStatus?: number
}

function httpsGetJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      reject(error)
    }
    const req = httpsGet(
      url,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout: REQUEST_TIMEOUT_MS },
      res => {
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy()
            return fail(new Error('MusicBrainz 响应体过大，已中止。'))
          }
          chunks.push(chunk)
        })
        res.on('error', err => fail(err instanceof Error ? err : new Error(String(err))))
        res.on('end', () => {
          if (settled) return
          const text = Buffer.concat(chunks).toString('utf8')
          if (status !== 200) {
            const error: MbHttpError = new Error(
              status === 503
                ? 'MusicBrainz 服务繁忙（HTTP 503），请稍后重试。'
                : `MusicBrainz 查询失败（HTTP ${status}）。`
            )
            error.mbStatus = status
            return fail(error)
          }
          try {
            const parsed = JSON.parse(text)
            settled = true
            clearTimeout(deadline)
            resolve(parsed)
          } catch {
            fail(new Error('MusicBrainz 返回了无法解析的数据。'))
          }
        })
      }
    )
    // idle timeout 之外的绝对 deadline；节点事件均异步，deadline 在此声明安全
    const deadline = setTimeout(() => {
      req.destroy()
      fail(new Error('MusicBrainz 请求超时。'))
    }, REQUEST_DEADLINE_MS)
    req.on('timeout', () => {
      req.destroy()
      fail(new Error('MusicBrainz 请求超时。'))
    })
    req.on('error', err => fail(err instanceof Error ? err : new Error(String(err))))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 503（服务繁忙）时有限重试；其余错误直接抛出。 */
async function searchRecordings(query: string): Promise<MusicBrainzCandidate[]> {
  const url = `${SEARCH_URL}?query=${encodeURIComponent(query)}&fmt=json&limit=${SEARCH_LIMIT}`
  for (let attempt = 0; ; attempt++) {
    try {
      return parseRecordings(await scheduleRequest(() => httpsGetJson(url)))
    } catch (error) {
      if (attempt >= BUSY_RETRIES || (error as MbHttpError)?.mbStatus !== 503) throw error
      await sleep(BUSY_RETRY_DELAY_MS)
    }
  }
}

// ---------- 响应解析与排序 ----------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function artistCreditName(credit: unknown): string | null {
  let out = ''
  for (const entry of asArray(credit)) {
    const item = asRecord(entry)
    if (!item) continue
    out += asString(item.name) ?? asString(asRecord(item.artist)?.name) ?? ''
    out += asString(item.joinphrase) ?? ''
  }
  const name = out.trim()
  return name.length > 0 ? name : null
}

/** artist-credit 里第一个带 id 的艺术家。 */
function artistCreditId(credit: unknown): string | null {
  for (const entry of asArray(credit)) {
    const item = asRecord(entry)
    if (!item) continue
    const id = asString(asRecord(item.artist)?.id)
    if (id) return id
  }
  return null
}

/** Cover Art Archive 的专辑正面图；没有 release id 时无法构造。 */
function coverUrlForRelease(releaseId: string | null): string | null {
  return releaseId ? `https://coverartarchive.org/release/${releaseId}/front-500` : null
}

function parseRecordings(body: unknown): MusicBrainzCandidate[] {
  const root = asRecord(body)
  const out: MusicBrainzCandidate[] = []
  for (const raw of asArray(root?.recordings)) {
    const rec = asRecord(raw)
    if (!rec) continue
    const id = asString(rec.id)
    const title = asString(rec.title)
    if (!id || !title) continue

    const lengthMs = asNumber(rec.length)
    let album: string | null = null
    let releaseDate: string | null = null
    let releaseId: string | null = null
    for (const rawRelease of asArray(rec.releases)) {
      const release = asRecord(rawRelease)
      if (!release) continue
      album ??= asString(release.title)
      releaseDate ??= asString(release.date)
      releaseId ??= asString(release.id)
      if (album && releaseDate && releaseId) break
    }

    out.push({
      id,
      title,
      artist: artistCreditName(rec['artist-credit']),
      artistId: artistCreditId(rec['artist-credit']),
      durationSec: lengthMs !== null && lengthMs > 0 ? Math.round(lengthMs / 1000) : null,
      firstReleaseDate: asString(rec['first-release-date']),
      score: asNumber(rec.score) ?? 0,
      album,
      releaseId,
      coverUrl: coverUrlForRelease(releaseId)
    })
  }
  return out
}

/**
 * 时长只作小幅排序加权（≤3 分），不做硬过滤、也不改写 score：
 * 无时长或版本时长稍差的候选仍保留，仅在 MB 原始分接近时靠前。
 */
function rankCandidates(candidates: MusicBrainzCandidate[], localDurationSec: number | null): MusicBrainzCandidate[] {
  return candidates
    .map(candidate => ({ candidate, rank: candidate.score + durationBonus(localDurationSec, candidate.durationSec) }))
    .sort((a, b) => b.rank - a.rank || b.candidate.score - a.candidate.score)
    .map(item => item.candidate)
    .slice(0, MAX_CANDIDATES)
}

function durationBonus(localSec: number | null, candidateSec: number | null): number {
  if (localSec === null || candidateSec === null) return 0
  const diff = Math.abs(localSec - candidateSec)
  if (diff <= 2) return 3
  if (diff <= 5) return 2
  if (diff <= 10) return 1
  return 0
}
