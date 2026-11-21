import { randomUUID } from 'crypto'
import { basename, extname } from 'path'
import { shell } from 'electron'
import type { LibraryDatabase } from './library-db'
import {
  canRestoreLocalTrackFile,
  sameLocalTrackFile,
  validateLocalTrackFile,
  validateLocalTrackFileSync
} from './local-track-file'
import type {
  CloudEntry,
  ExportedTrackRef,
  LibraryExportData,
  LibraryImportResult,
  PlaybackQueueState,
  PlaylistSummary,
  RepeatMode,
  SongInfoTask,
  SongInfoTaskStatus,
  Track,
  TrackDetail,
  TrackIdentification,
  TracksPage
} from '../shared/ipc'

export interface TrackRow {
  id: string
  source_id: string
  remote_id: string | null
  path: string
  title: string
  artist: string | null
  duration_sec: number | null
  size: number
  modified_at: number
  md5: string | null
  is_deleted: number
  album: string | null
  cover_url: string | null
  mb_recording_id: string | null
  mb_release_id: string | null
  mb_artist_id: string | null
  mb_score: number | null
  mb_identified_at: number | null
}

/** tracks 表的完整列清单（带别名/前缀的查询单独写）。 */
const TRACK_COLUMNS = `id, source_id, remote_id, path, title, artist, duration_sec, size,
             modified_at, md5, is_deleted, album, cover_url, mb_recording_id, mb_release_id,
             mb_artist_id, mb_score, mb_identified_at`

/** JOIN 场景下的同列清单（带表前缀）。 */
const TRACK_COLUMNS_T = `t.id, t.source_id, t.remote_id, t.path, t.title, t.artist, t.duration_sec,
             t.size, t.modified_at, t.md5, t.is_deleted, t.album, t.cover_url, t.mb_recording_id,
             t.mb_release_id, t.mb_artist_id, t.mb_score, t.mb_identified_at`

export interface LibraryRootRow {
  id: string
  source_id: string
  root_path: string
  playlist_id: string | null
  last_sync_at: number | null
  last_sync_status: string | null
}

export interface CloudUpsertResult {
  trackId: string
  status: 'added' | 'updated' | 'unchanged'
  previousPath: string | null
}

export interface RemovedTrackInfo {
  id: string
  title: string
  artist: string | null
  path: string
}

export interface TrackEditInput {
  title: string
  artist: string | null
}

export interface SongLyricsLine {
  original: string
  translated: string
}

export interface SongMeta {
  id: string
  path: string
  title: string
  intro: string
  lyrics: string | SongLyricsLine[]
  lyricsBilingual: SongLyricsLine[]
  source: string
  model: string
  found: boolean
  reason?: string
  updatedAt: number
}

export interface SongMetaInput {
  path: string
  title: string
  intro: string
  lyrics: string
  lyricsBilingual: SongLyricsLine[]
  source: string
  model: string
  found: boolean
  reason?: string
}

export function trackPlaybackUrl(id: string): string {
  return `app-media://${id}/audio`
}

export function rowToTrack(row: TrackRow): Track {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    durationSec: row.duration_sec,
    sourceId: row.source_id,
    playbackUrl: trackPlaybackUrl(row.id),
    identified: Boolean(row.mb_recording_id)
  }
}

export function rowToTrackDetail(row: TrackRow): TrackDetail {
  return {
    ...rowToTrack(row),
    path: row.path,
    size: row.size,
    modifiedAt: row.modified_at,
    md5: row.md5,
    remoteId: row.remote_id,
    album: row.album ?? null,
    coverUrl: row.cover_url ?? null,
    mbRecordingId: row.mb_recording_id ?? null,
    mbReleaseId: row.mb_release_id ?? null,
    mbArtistId: row.mb_artist_id ?? null,
    mbScore: row.mb_score ?? null,
    identifiedAt: row.mb_identified_at ?? null,
    identified: row.mb_recording_id ? true : false
  }
}

export interface PlayHistoryEntry {
  track: Track
  playedAt: number
}

interface SongMetaDbRow {
  id: string
  path: string
  title: string
  intro: string
  lyrics: string
  lyrics_bilingual: string
  source: string
  model: string
  found: number
  reason: string | null
  updated_at: number
}

/** 任务摘要行：列表/详情读取用，不含 prompt/path/source/result_json 等大字段。 */
export interface SongInfoTaskSummaryRow {
  id: string
  track_id: string | null
  title: string
  artist: string | null
  model: string
  status: string
  started_at: number
  finished_at: number | null
  tool_call_count: number
  current_tool: string | null
  message: string | null
}

/** 完整任务行：仅重试记录读取用（含原始请求与结果快照）。 */
export interface SongInfoTaskRow extends SongInfoTaskSummaryRow {
  prompt: string
  path: string
  source: string
  result_json: string | null
}

export interface SongInfoTaskInput {
  trackId: string | null
  prompt: string
  path: string
  title: string
  artist: string | null
  source: string
  model: string
}

/** 摘要读取投影：不含 prompt/path/source/result_json，摘要不携带原始请求与结果。 */
const SONG_INFO_TASK_SUMMARY_COLUMNS =
  'id, track_id, title, artist, model, status, started_at, finished_at, tool_call_count, current_tool, message'
const SONG_INFO_TASK_COLUMNS = `${SONG_INFO_TASK_SUMMARY_COLUMNS}, prompt, path, source, result_json`

function songInfoTaskFromRow(row: SongInfoTaskSummaryRow): SongInfoTask {
  return {
    id: row.id,
    trackId: row.track_id,
    title: row.title,
    artist: row.artist,
    model: row.model,
    status: row.status as SongInfoTaskStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    toolCallCount: row.tool_call_count,
    currentTool: row.current_tool,
    message: row.message
  }
}

function songMetaFromRow(row: SongMetaDbRow): SongMeta {
  let lyricsBilingual: SongLyricsLine[] = []
  try {
    const parsed: unknown = JSON.parse(row.lyrics_bilingual)
    if (Array.isArray(parsed)) {
      lyricsBilingual = parsed.filter((line): line is SongLyricsLine =>
        !!line && typeof line === 'object' &&
        typeof (line as SongLyricsLine).original === 'string' &&
        typeof (line as SongLyricsLine).translated === 'string'
      )
    }
  } catch {
    // 损坏的歌词双语数据不影响回查其它字段
  }
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    intro: row.intro,
    lyrics: lyricsBilingual.length > 0 ? lyricsBilingual : row.lyrics,
    lyricsBilingual,
    source: row.source,
    model: row.model,
    found: row.found === 1,
    ...(row.reason ? { reason: row.reason } : {}),
    updatedAt: row.updated_at
  }
}

/** AI 补全字段校验：与手动编辑同一套限制（≤500 字符、无空字符）；不合规一律忽略而非报错。 */
function sanitizeAiMetaValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 500 || trimmed.includes('\0')) return null
  return trimmed
}

/** 识别结果字段校验：默认 ≤500 字符（与手动编辑一致），封面地址放宽到 2000；空值返回 null。 */
function cleanIdentificationText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || trimmed.includes('\0')) return null
  return trimmed
}

export class LibraryService {
  private lastSyncToken = Date.now()
  private readonly pendingLocalDeletes = new Set<string>()

  constructor(private readonly db: LibraryDatabase) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS local_track_delete_intents (track_id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at INTEGER NOT NULL)`)
  }

  createSyncToken(): number {
    this.lastSyncToken = Math.max(Date.now(), this.lastSyncToken + 1)
    return this.lastSyncToken
  }

  getTrackRow(id: string): TrackRow | null {
    const row = this.db.prepare(`
      SELECT ${TRACK_COLUMNS}
      FROM tracks
      WHERE id = ? AND is_deleted = 0
    `).get(id) as TrackRow | undefined
    return row ?? null
  }

  getTrackDetail(id: string): TrackDetail | null {
    const row = this.getTrackRow(id)
    return row ? rowToTrackDetail(row) : null
  }

  resolveMedia(id: string): { kind: 'local' | 'baidu' | 'webdav'; path: string } | null {
    const row = this.getTrackRow(id)
    if (!row) return null
    if (row.source_id === 'local') return { kind: 'local', path: row.path }
    if (row.source_id === 'baidu') return { kind: 'baidu', path: row.path }
    if (row.source_id === 'quark') return { kind: 'webdav', path: row.path }
    return null
  }

  listTracksPage(
    sourceId: string,
    offset: number,
    limit: number,
    search = '',
    identified: 'all' | 'identified' | 'unidentified' = 'all'
  ): TracksPage {
    const trimmed = search.trim()
    const params: Array<string | number> = []
    let where = 'is_deleted = 0'
    if (sourceId !== 'all') {
      where = 'source_id = ? AND is_deleted = 0'
      params.push(sourceId)
    }
    if (trimmed) {
      where += ' AND (title LIKE ? ESCAPE \'\\\' OR artist LIKE ? ESCAPE \'\\\')'
      const pattern = `%${trimmed.replace(/[%_\\]/g, char => `\\${char}`)}%`
      params.push(pattern, pattern)
    }
    if (identified === 'identified') where += ' AND mb_recording_id IS NOT NULL'
    else if (identified === 'unidentified') where += ' AND mb_recording_id IS NULL'

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS count FROM tracks WHERE ${where}`
    ).get(...params) as { count: number }

    params.push(limit, offset)
    const rows = this.db.prepare(`
      SELECT ${TRACK_COLUMNS}
      FROM tracks
      WHERE ${where}
      ORDER BY title COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `).all(...params) as unknown as TrackRow[]

    return {
      tracks: rows.map(rowToTrack),
      total: Number(totalRow.count),
      offset,
      limit
    }
  }

  listAllTracks(sourceId: string): Track[] {
    const params: string[] = []
    let where = 'is_deleted = 0'
    if (sourceId !== 'all') {
      where = 'source_id = ? AND is_deleted = 0'
      params.push(sourceId)
    }
    const rows = this.db.prepare(`
      SELECT ${TRACK_COLUMNS}
      FROM tracks
      WHERE ${where}
      ORDER BY title COLLATE NOCASE ASC
    `).all(...params) as unknown as TrackRow[]
    return rows.map(rowToTrack)
  }

  upsertLocalTracksBatch(filePaths: string[]): void {
    runInTransaction(this.db, () => {
      for (const filePath of filePaths) this.upsertLocalTrack(filePath)
    })
  }

  upsertLocalTrack(filePath: string): Track {
    const now = Date.now()
    const title = basename(filePath, extname(filePath))
    const existing = this.db.prepare(`
      SELECT ${TRACK_COLUMNS}
      FROM tracks WHERE source_id = 'local' AND path = ? LIMIT 1
    `).get(filePath) as TrackRow | undefined

    if (existing) {
      // The scanner only refreshes presence. User-edited title/artist belong to
      // the library row, not the filename, and must survive every later scan.
      // A completed delete leaves a persistent tombstone: stale scan batches
      // cannot revive it unless the real file has actually been restored.
      const deleting = this.db.prepare('SELECT 1 FROM local_track_delete_intents WHERE track_id = ?').get(existing.id)
      const canUpsert = !deleting && !this.pendingLocalDeletes.has(filePath) &&
        (existing.is_deleted === 0 || canRestoreLocalTrackFile(filePath))
      if (canUpsert) {
        this.db.prepare(`
          UPDATE tracks SET updated_at = ?, is_deleted = 0 WHERE id = ?
        `).run(now, existing.id)
      }
      return rowToTrack(existing)
    }

    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO tracks (
        id, source_id, remote_id, path, title, artist, duration_sec, size,
        modified_at, md5, is_deleted, last_seen_sync, created_at, updated_at
      ) VALUES (?, 'local', NULL, ?, ?, NULL, NULL, 0, ?, NULL, 0, NULL, ?, ?)
    `).run(id, filePath, title, now, now, now)
    const row = this.getTrackRow(id)
    if (!row) throw new Error('无法保存本地曲目。')
    return rowToTrack(row)
  }

  /**
   * 保存 MusicBrainz 识别结果：标题/艺术家（缺省时保留原值）、专辑、封面地址、
   * recording/release/artist id 与搜索分数，并打上识别时间。
   * 只改音乐库记录，不写音频文件标签。
   */
  applyIdentification(id: string, input: TrackIdentification): TrackDetail {
    const row = this.getTrackRow(id)
    if (!row || row.source_id !== 'local') throw new Error('本地曲目不存在或已被删除。')
    if (this.pendingLocalDeletes.has(row.path)) {
      throw new Error('该曲目正在移入废纸篓，不能同时保存识别结果。')
    }
    const recordingId = (input.recordingId ?? '').trim()
    if (!recordingId) throw new Error('缺少 MusicBrainz 录音 id。')

    const title = cleanIdentificationText(input.title) ?? row.title
    const artist = cleanIdentificationText(input.artist) ?? row.artist
    const album = cleanIdentificationText(input.album)
    const coverUrl = cleanIdentificationText(input.coverUrl, 2000)
    const releaseId = cleanIdentificationText(input.releaseId)
    const artistId = cleanIdentificationText(input.artistId)
    const score = Number.isFinite(input.score) ? Math.round(Number(input.score)) : null

    const result = this.db.prepare(`
      UPDATE tracks
      SET title = ?, artist = ?, album = ?, cover_url = ?,
          mb_recording_id = ?, mb_release_id = ?, mb_artist_id = ?, mb_score = ?,
          mb_identified_at = ?, updated_at = ?
      WHERE id = ? AND source_id = 'local' AND is_deleted = 0
    `).run(title, artist, album, coverUrl, recordingId, releaseId, artistId, score,
      Date.now(), Date.now(), id)
    if (Number(result.changes) !== 1) throw new Error('本地曲目不存在或已被删除。')
    const updated = this.getTrackDetail(id)
    if (!updated) throw new Error('无法读取更新后的本地曲目。')
    return updated
  }

  async updateLocalTrack(id: string, input: TrackEditInput): Promise<TrackDetail> {
    if (!input || typeof input !== 'object' || typeof input.title !== 'string' ||
        (input.artist !== null && typeof input.artist !== 'string')) {
      throw new Error('标题必须是字符串，艺术家必须是字符串或 null。')
    }
    const title = input.title.trim()
    const artist = input.artist?.trim() || null
    if (!title) throw new Error('标题不能为空。')
    if (title.length > 500 || (artist?.length ?? 0) > 500) {
      throw new Error('标题和艺术家不能超过 500 个字符。')
    }
    if (title.includes('\0') || artist?.includes('\0')) {
      throw new Error('标题和艺术家不能包含空字符。')
    }

    const row = this.getTrackRow(id)
    if (!row || row.source_id !== 'local') throw new Error('本地曲目不存在或已被删除。')
    if (this.pendingLocalDeletes.has(row.path)) {
      throw new Error('该曲目正在移入废纸篓，不能同时编辑。')
    }
    await validateLocalTrackFile(row.path, false)
    if (this.pendingLocalDeletes.has(row.path)) {
      throw new Error('该曲目正在移入废纸篓，不能同时编辑。')
    }

    const result = this.db.prepare(`
      UPDATE tracks SET title = ?, artist = ?, updated_at = ?
      WHERE id = ? AND source_id = 'local' AND is_deleted = 0
    `).run(title, artist, Date.now(), id)
    if (Number(result.changes) !== 1) throw new Error('本地曲目不存在或已被删除。')
    const updated = this.getTrackDetail(id)
    if (!updated) throw new Error('无法读取更新后的本地曲目。')
    return updated
  }

  /**
   * 用 AI 检索结果补全曲目元数据（同一次检索，不额外调用模型）：
   * - 标题仅当仍等于路径文件名（去扩展名，即导入时的默认标题）时才替换；
   * - 艺术家仅当当前为空时才填入；
   * - 仅本地曲目；已删除或有删除意图的曲目不更新；不触碰音频文件。
   * WHERE 里比对读取到的当前值（title/artist），检索期间用户手动改过的字段不会被覆盖。
   * 返回是否真的写入了字段。
   */
  fillTrackMetaFromAi(trackId: string, aiTitle: unknown, aiArtist: unknown): boolean {
    const title = sanitizeAiMetaValue(aiTitle)
    const artist = sanitizeAiMetaValue(aiArtist)
    if (!title && !artist) return false

    const row = this.getTrackRow(trackId) // 已过滤 is_deleted = 0
    if (!row || row.source_id !== 'local') return false
    if (this.pendingLocalDeletes.has(row.path)) return false
    const deleting = this.db.prepare(
      'SELECT 1 FROM local_track_delete_intents WHERE track_id = ? LIMIT 1'
    ).get(trackId)
    if (deleting) return false

    const nextTitle = title && row.title === basename(row.path, extname(row.path)) ? title : null
    const nextArtist = artist && !row.artist?.trim() ? artist : null
    if (!nextTitle && !nextArtist) return false

    const info = this.db.prepare(`
      UPDATE tracks
      SET title = CASE WHEN ? IS NULL THEN title ELSE ? END,
          artist = CASE WHEN ? IS NULL THEN artist ELSE ? END,
          updated_at = ?
      WHERE id = ? AND source_id = 'local' AND is_deleted = 0
        AND title = ? AND artist IS ?
        AND NOT EXISTS (SELECT 1 FROM local_track_delete_intents WHERE track_id = tracks.id)
    `).run(nextTitle, nextTitle, nextArtist, nextArtist, Date.now(), trackId, row.title, row.artist)
    return Number(info.changes) > 0
  }

  async deleteLocalTrack(id: string): Promise<TrackDetail> {
    const row = this.getTrackRow(id)
    if (!row || row.source_id !== 'local') throw new Error('本地曲目不存在或已被删除。')
    if (this.pendingLocalDeletes.has(row.path)) {
      throw new Error('该曲目正在移入废纸篓，请稍后重试。')
    }

    // Set before the first await so scanner upserts cannot refresh this row
    // while the filesystem operation is in flight.
    this.pendingLocalDeletes.add(row.path)
    try {
      const before = await validateLocalTrackFile(row.path, false)
      // Close the async validation window: do not trash a replaced or modified
      // file based on stale metadata from the first check.
      const current = validateLocalTrackFileSync(row.path, false)
      if (!sameLocalTrackFile(before, current)) {
        throw new Error('本地音频文件在操作期间已变化，请刷新后重试。')
      }

      // Intent and tombstone are committed together; an interrupted operation
      // leaves an intent that blocks automatic resurrection until inspected.
      runInTransaction(this.db, () => {
        this.db.prepare('INSERT INTO local_track_delete_intents (track_id, path, created_at) VALUES (?, ?, ?)').run(id, row.path, Date.now())
        const marked = this.db.prepare(`
          UPDATE tracks SET is_deleted = 1, updated_at = ?
          WHERE id = ? AND source_id = 'local' AND is_deleted = 0
        `).run(Date.now(), id)
        if (Number(marked.changes) !== 1) throw new Error('本地曲目不存在或已被删除。')
      })

      try {
        await shell.trashItem(current.path)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        let unchanged = false
        try { unchanged = sameLocalTrackFile(current, validateLocalTrackFileSync(row.path, false)) } catch { /* outcome uncertain */ }
        if (!unchanged) {
          throw new Error(`移入废纸篓的结果不确定，曲库记录暂时隐藏，请检查文件和废纸篓：${message}`)
        }
        runInTransaction(this.db, () => {
          this.db.prepare('UPDATE tracks SET is_deleted = 0, updated_at = ? WHERE id = ?').run(Date.now(), id)
          this.db.prepare('DELETE FROM local_track_delete_intents WHERE track_id = ?').run(id)
        })
        throw new Error(`移入废纸篓失败，曲库索引未删除：${message}`)
      }
      this.db.prepare('DELETE FROM local_track_delete_intents WHERE track_id = ?').run(id)

      // Associations (playlists, favorites, history, queue) deliberately stay
      // intact; normal track queries hide the soft-deleted row.
      return rowToTrackDetail(row)
    } finally {
      this.pendingLocalDeletes.delete(row.path)
    }
  }

  upsertCloudTrack(sourceId: 'baidu' | 'quark', entry: CloudEntry, syncToken: number): CloudUpsertResult {
    const now = Date.now()
    const remoteId = entry.id
    const title = basename(entry.name, extname(entry.name))

    const byRemote = this.db.prepare(`
      SELECT id, path, title, size, modified_at, is_deleted
      FROM tracks
      WHERE source_id = ? AND remote_id = ? LIMIT 1
    `).get(sourceId, remoteId) as
      { id: string; path: string; title: string; size: number; modified_at: number; is_deleted: number } | undefined

    if (byRemote) {
      const pathChanged = byRemote.path !== entry.path
      const changed = pathChanged ||
        byRemote.title !== title ||
        byRemote.size !== entry.size ||
        byRemote.modified_at !== entry.modifiedAt
      this.db.prepare(`
        UPDATE tracks SET
          path = ?, title = ?, size = ?, modified_at = ?,
          is_deleted = 0, last_seen_sync = ?, updated_at = ?
        WHERE id = ?
      `).run(entry.path, title, entry.size, entry.modifiedAt, syncToken, now, byRemote.id)
      if (byRemote.is_deleted === 1) {
        return { trackId: byRemote.id, status: 'added', previousPath: null }
      }
      return {
        trackId: byRemote.id,
        status: changed ? 'updated' : 'unchanged',
        previousPath: pathChanged ? byRemote.path : null
      }
    }

    const byPath = this.db.prepare(`
      SELECT id, remote_id, title, size, modified_at, is_deleted
      FROM tracks WHERE source_id = ? AND path = ? LIMIT 1
    `).get(sourceId, entry.path) as
      { id: string; remote_id: string | null; title: string; size: number; modified_at: number; is_deleted: number } | undefined

    if (byPath) {
      const changed = byPath.remote_id !== remoteId ||
        byPath.title !== title ||
        byPath.size !== entry.size ||
        byPath.modified_at !== entry.modifiedAt
      this.db.prepare(`
        UPDATE tracks SET
          remote_id = ?, title = ?, size = ?, modified_at = ?,
          is_deleted = 0, last_seen_sync = ?, updated_at = ?
        WHERE id = ?
      `).run(remoteId, title, entry.size, entry.modifiedAt, syncToken, now, byPath.id)
      if (byPath.is_deleted === 1) {
        return { trackId: byPath.id, status: 'added', previousPath: null }
      }
      return { trackId: byPath.id, status: changed ? 'updated' : 'unchanged', previousPath: null }
    }

    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO tracks (
        id, source_id, remote_id, path, title, artist, duration_sec, size,
        modified_at, md5, is_deleted, last_seen_sync, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, 0, ?, ?, ?)
    `).run(id, sourceId, remoteId, entry.path, title, entry.size, entry.modifiedAt, syncToken, now, now)
    return { trackId: id, status: 'added', previousPath: null }
  }

  upsertBaiduTrack(entry: CloudEntry, syncToken: number): CloudUpsertResult {
    return this.upsertCloudTrack('baidu', entry, syncToken)
  }

  markCloudRootStale(sourceId: 'baidu' | 'quark', rootPath: string, syncToken: number): void {
    const root = rootPathFilter(rootPath)
    this.db.prepare(`
      UPDATE tracks SET last_seen_sync = NULL
      WHERE source_id = ? AND ${root.sql}
    `).run(sourceId, ...root.params)
    void syncToken
  }

  markBaiduRootStale(rootPath: string, syncToken: number): void {
    this.markCloudRootStale('baidu', rootPath, syncToken)
  }

  finalizeCloudRootSync(sourceId: 'baidu' | 'quark', rootPath: string, syncToken: number): RemovedTrackInfo[] {
    const root = rootPathFilter(rootPath)
    const removed = this.db.prepare(`
      SELECT id, title, artist, path
      FROM tracks
      WHERE source_id = ?
        AND is_deleted = 0
        AND ${root.sql}
        AND (last_seen_sync IS NULL OR last_seen_sync != ?)
    `).all(sourceId, ...root.params, syncToken) as unknown as RemovedTrackInfo[]

    this.db.prepare(`
      UPDATE tracks SET is_deleted = 1, updated_at = ?
      WHERE source_id = ?
        AND ${root.sql}
        AND (last_seen_sync IS NULL OR last_seen_sync != ?)
    `).run(Date.now(), sourceId, ...root.params, syncToken)
    return removed
  }

  finalizeBaiduRootSync(rootPath: string, syncToken: number): RemovedTrackInfo[] {
    return this.finalizeCloudRootSync('baidu', rootPath, syncToken)
  }

  upsertLibraryRoot(sourceId: string, rootPath: string, playlistId: string): void {
    const normalized = normalizeRootPrefix(rootPath)
    const existing = this.db.prepare(`
      SELECT id FROM library_roots WHERE source_id = ? AND root_path = ? LIMIT 1
    `).get(sourceId, normalized) as { id: string } | undefined

    const now = Date.now()
    if (existing) {
      this.db.prepare(`
        UPDATE library_roots SET playlist_id = ?, last_sync_at = ?, last_sync_status = 'ok'
        WHERE id = ?
      `).run(playlistId, now, existing.id)
      return
    }

    this.db.prepare(`
      INSERT INTO library_roots (id, source_id, root_path, playlist_id, last_sync_at, last_sync_status)
      VALUES (?, ?, ?, ?, ?, 'ok')
    `).run(randomUUID(), sourceId, normalized, playlistId, now)
  }

  /**
   * 确保某音乐库目录有可用的关联歌单。若 library_roots.playlist_id 指向的
   * 歌单已被删除（悬空引用），则重建歌单并修复 library_roots 关联，避免
   * 后续 replacePlaylistTracks 触发 playlist_tracks→playlists 外键失败。
   */
  ensurePlaylistForRoot(sourceId: 'baidu' | 'quark', rootPath: string): string {
    const normalized = normalizeRootPrefix(rootPath)
    const linked = this.db.prepare(`
      SELECT p.id FROM library_roots lr
      JOIN playlists p ON p.id = lr.playlist_id
      WHERE lr.source_id = ? AND lr.root_path = ?
    `).get(sourceId, normalized) as { id: string } | undefined
    if (linked?.id) return linked.id

    const fallbackName = normalized === '/' ? '音乐库' : basename(normalized) || '音乐库'
    const playlist = this.createPlaylist(fallbackName)
    const existing = this.db.prepare(`
      SELECT id FROM library_roots WHERE source_id = ? AND root_path = ? LIMIT 1
    `).get(sourceId, normalized) as { id: string } | undefined
    if (existing) {
      this.db.prepare('UPDATE library_roots SET playlist_id = ? WHERE id = ?').run(playlist.id, existing.id)
    } else {
      this.upsertLibraryRoot(sourceId, normalized, playlist.id)
    }
    return playlist.id
  }

  listLibraryRoots(sourceId: string): LibraryRootRow[] {
    return this.db.prepare(`
      SELECT id, source_id, root_path, playlist_id, last_sync_at, last_sync_status
      FROM library_roots
      WHERE source_id = ?
      ORDER BY (last_sync_at IS NULL), last_sync_at DESC
    `).all(sourceId) as unknown as LibraryRootRow[]
  }

  trackIdsUnderBaiduRoot(rootPath: string): string[] {
    const root = rootPathFilter(rootPath)
    const rows = this.db.prepare(`
      SELECT id FROM tracks
      WHERE source_id = 'baidu' AND is_deleted = 0 AND ${root.sql}
      ORDER BY title COLLATE NOCASE ASC
    `).all(...root.params) as Array<{ id: string }>
    return rows.map(row => row.id)
  }

  savePlaybackQueue(state: PlaybackQueueState): void {
    const currentIndex = Number.isInteger(state.currentIndex) && state.currentIndex >= -1
      ? Math.min(state.currentIndex, state.tracks.length - 1)
      : -1
    const repeatMode: RepeatMode = state.repeatMode === 'all' || state.repeatMode === 'one'
      ? state.repeatMode
      : 'off'
    const playOrder = state.playOrder.filter(index => Number.isInteger(index) && index >= 0 && index < state.tracks.length)

    runInTransaction(this.db, () => {
      this.db.prepare('DELETE FROM queue_tracks').run()
      const insert = this.db.prepare('INSERT INTO queue_tracks (position, track_id) VALUES (?, ?)')
      state.tracks.forEach((track, position) => insert.run(position, track.id))
      this.db.prepare(`
        INSERT INTO queue_state (id, current_index, shuffle, repeat_mode, play_order)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          current_index = excluded.current_index,
          shuffle = excluded.shuffle,
          repeat_mode = excluded.repeat_mode,
          play_order = excluded.play_order
      `).run(currentIndex, state.shuffle ? 1 : 0, repeatMode, JSON.stringify(playOrder))
    })
  }

  loadPlaybackQueue(): PlaybackQueueState | null {
    const stateRow = this.db.prepare(`
      SELECT current_index, shuffle, repeat_mode, play_order
      FROM queue_state
      WHERE id = 1
    `).get() as {
      current_index: number
      shuffle: number
      repeat_mode: string
      play_order: string
    } | undefined
    if (!stateRow) return null

    const rows = this.db.prepare(`
      SELECT qt.position, t.id, t.source_id, t.remote_id, t.path, t.title, t.artist,
             t.duration_sec, t.size, t.modified_at, t.md5, t.is_deleted
      FROM queue_tracks qt
      JOIN tracks t ON t.id = qt.track_id
      WHERE t.is_deleted = 0
      ORDER BY qt.position ASC
    `).all() as unknown as Array<TrackRow & { position: number }>
    const tracks = rows.map(rowToTrack)
    const activePositions = new Map(rows.map((row, index) => [row.position, index]))

    let currentIndex = -1
    if (rows.length > 0) {
      currentIndex = rows.findIndex(row => row.position === stateRow.current_index)
      if (currentIndex < 0) currentIndex = rows.findIndex(row => row.position > stateRow.current_index)
      if (currentIndex < 0) currentIndex = rows.length - 1
    }

    let savedOrder: unknown = []
    try {
      savedOrder = JSON.parse(stateRow.play_order)
    } catch {
      savedOrder = []
    }
    const playOrder: number[] = []
    if (Array.isArray(savedOrder)) {
      for (const value of savedOrder) {
        if (!Number.isInteger(value)) continue
        const activeIndex = activePositions.get(value)
        if (activeIndex !== undefined && !playOrder.includes(activeIndex)) playOrder.push(activeIndex)
      }
    }
    for (let index = 0; index < tracks.length; index += 1) {
      if (!playOrder.includes(index)) playOrder.push(index)
    }

    return {
      tracks,
      currentIndex,
      shuffle: stateRow.shuffle === 1,
      repeatMode: stateRow.repeat_mode === 'all' || stateRow.repeat_mode === 'one'
        ? stateRow.repeat_mode
        : 'off',
      playOrder
    }
  }

  listPlaylists(): PlaylistSummary[] {
    const rows = this.db.prepare(`
      SELECT p.id, p.name, p.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS trackCount
      FROM playlists p
      ORDER BY p.updated_at DESC
    `).all() as Array<{ id: string; name: string; updatedAt: number; trackCount: number }>

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      trackCount: row.trackCount,
      updatedAt: row.updatedAt
    }))
  }

  createPlaylist(name: string): PlaylistSummary {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('歌单名称不能为空。')
    const now = Date.now()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run(id, trimmed, now, now)
    return { id, name: trimmed, trackCount: 0, updatedAt: now }
  }

  renamePlaylist(id: string, name: string): PlaylistSummary {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('歌单名称不能为空。')
    const now = Date.now()
    const result = this.db.prepare(`
      UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?
    `).run(trimmed, now, id)
    if (Number(result.changes) === 0) throw new Error('歌单不存在。')
    const summary = this.listPlaylists().find(playlist => playlist.id === id)
    if (!summary) throw new Error('歌单不存在。')
    return summary
  }

  deletePlaylist(id: string): void {
    const libRoot = this.db.prepare(`
      SELECT root_path FROM library_roots WHERE playlist_id = ? LIMIT 1
    `).get(id) as { root_path: string } | undefined
    if (libRoot) throw new Error(`「${libRoot.root_path}」是音乐库的关联歌单，不能删除。`)
    runInTransaction(this.db, () => {
      this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id)
      this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
    })
  }

  listPlaylistTracks(playlistId: string): Track[] {
    const rows = this.db.prepare(`
      SELECT ${TRACK_COLUMNS_T}
      FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ? AND t.is_deleted = 0
      ORDER BY pt.position ASC
    `).all(playlistId) as unknown as TrackRow[]
    return rows.map(rowToTrack)
  }

  addTrackToPlaylist(playlistId: string, trackId: string): void {
    if (!this.getTrackRow(trackId)) throw new Error('曲目不存在或已被删除。')
    const exists = this.db.prepare(`
      SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ? LIMIT 1
    `).get(playlistId, trackId)
    if (exists) return

    const maxRow = this.db.prepare(`
      SELECT COALESCE(MAX(position), -1) AS maxPos FROM playlist_tracks WHERE playlist_id = ?
    `).get(playlistId) as { maxPos: number }
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
      VALUES (?, ?, ?, ?)
    `).run(playlistId, trackId, maxRow.maxPos + 1, now)
    this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId)
  }

  addTracksToPlaylist(playlistId: string, trackIds: string[]): void {
    runInTransaction(this.db, () => {
      for (const trackId of trackIds) {
        this.addTrackToPlaylist(playlistId, trackId)
      }
    })
  }

  replacePlaylistTracks(playlistId: string, trackIds: string[]): void {
    const uniqueTrackIds = [...new Set(trackIds)]
    const insert = this.db.prepare(`
      INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
      VALUES (?, ?, ?, ?)
    `)
    const now = Date.now()

    runInTransaction(this.db, () => {
      this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId)
      uniqueTrackIds.forEach((trackId, position) => {
        if (this.getTrackRow(trackId)) insert.run(playlistId, trackId, position, now)
      })
      this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId)
    })
  }

  removeTrackFromPlaylist(playlistId: string, trackId: string): void {
    const now = Date.now()
    this.db.prepare(`
      DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?
    `).run(playlistId, trackId)
    this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId)
  }

  listFavoriteTracks(): Track[] {
    const rows = this.db.prepare(`
      SELECT ${TRACK_COLUMNS_T}
      FROM favorites f
      JOIN tracks t ON t.id = f.track_id
      WHERE t.is_deleted = 0
      ORDER BY f.added_at DESC
    `).all() as unknown as TrackRow[]
    return rows.map(rowToTrack)
  }

  addFavorite(trackId: string): void {
    if (!this.getTrackRow(trackId)) throw new Error('曲目不存在或已被删除。')
    this.db.prepare(`
      INSERT INTO favorites (track_id, added_at) VALUES (?, ?)
      ON CONFLICT(track_id) DO NOTHING
    `).run(trackId, Date.now())
  }

  removeFavorite(trackId: string): void {
    this.db.prepare('DELETE FROM favorites WHERE track_id = ?').run(trackId)
  }

  isFavorite(trackId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM favorites WHERE track_id = ? LIMIT 1'
    ).get(trackId)
    return row !== undefined
  }

  recordPlay(trackId: string): void {
    if (!this.getTrackRow(trackId)) return
    this.db.prepare('INSERT INTO play_history (track_id, played_at) VALUES (?, ?)').run(
      trackId,
      Date.now()
    )
  }

  listPlayHistory(limit: number): PlayHistoryEntry[] {
    const capped = Math.max(1, Math.min(Math.trunc(limit) || 20, 500))
    const rows = this.db.prepare(`
      SELECT t.id, t.source_id, t.remote_id, t.path, t.title, t.artist, t.duration_sec,
             t.size, t.modified_at, t.md5, t.is_deleted, h.played_at
      FROM play_history h
      JOIN tracks t ON t.id = h.track_id
      WHERE t.is_deleted = 0
      ORDER BY h.played_at DESC
      LIMIT ?
    `).all(capped) as unknown as Array<TrackRow & { played_at: number }>
    return rows.map(row => ({ track: rowToTrack(row), playedAt: row.played_at }))
  }

  /** 导出歌单与收藏（跳过音乐库自动关联歌单，避免换机重导入后重复）。 */
  exportUserData(): LibraryExportData {
    const linkedIds = new Set(
      (this.db.prepare(
        'SELECT DISTINCT playlist_id FROM library_roots WHERE playlist_id IS NOT NULL'
      ).all() as Array<{ playlist_id: string }>).map(row => row.playlist_id)
    )
    const playlistTracks = this.db.prepare(`
      SELECT t.source_id, t.path, t.title, t.artist
      FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ? AND t.is_deleted = 0
      ORDER BY pt.position ASC
    `)
    const toRef = (row: Record<string, unknown>): ExportedTrackRef => ({
      sourceId: row.source_id as string,
      path: row.path as string,
      title: row.title as string,
      artist: (row.artist as string | null) ?? null
    })
    const playlists = this.listPlaylists()
      .filter(playlist => !linkedIds.has(playlist.id))
      .map(playlist => ({
        name: playlist.name,
        tracks: (playlistTracks.all(playlist.id) as Array<Record<string, unknown>>).map(toRef)
      }))
    const favorites = (this.db.prepare(`
      SELECT t.source_id, t.path, t.title, t.artist
      FROM favorites f
      JOIN tracks t ON t.id = f.track_id
      WHERE t.is_deleted = 0
      ORDER BY f.added_at DESC
    `).all() as Array<Record<string, unknown>>).map(toRef)
    return { app: 'corner', version: 1, exportedAt: Date.now(), playlists, favorites }
  }

  /** 导入备份：按 (sourceId, path) 匹配本机曲目；同名歌单合并追加，收藏去重。 */
  importUserData(data: LibraryExportData): LibraryImportResult {
    if (!data || !Array.isArray(data.playlists) || !Array.isArray(data.favorites)) {
      throw new Error('无效的备份文件。')
    }
    const findTrackId = (ref: ExportedTrackRef): string | null => {
      if (!ref || typeof ref.sourceId !== 'string' || typeof ref.path !== 'string') return null
      const row = this.db.prepare(`
        SELECT id FROM tracks WHERE source_id = ? AND path = ? AND is_deleted = 0 LIMIT 1
      `).get(ref.sourceId, ref.path) as { id: string } | undefined
      return row?.id ?? null
    }

    const result: LibraryImportResult = {
      playlistsCreated: 0,
      playlistsMatched: 0,
      tracksAdded: 0,
      tracksMissing: 0,
      favoritesAdded: 0,
      favoritesExisting: 0
    }

    runInTransaction(this.db, () => {
      for (const playlist of data.playlists) {
        const name = typeof playlist?.name === 'string' ? playlist.name.trim() : ''
        if (!name || !Array.isArray(playlist.tracks)) continue
        const existing = this.db.prepare(
          'SELECT id FROM playlists WHERE name = ? LIMIT 1'
        ).get(name) as { id: string } | undefined
        const playlistId = existing
          ? (result.playlistsMatched += 1, existing.id)
          : (result.playlistsCreated += 1, this.createPlaylist(name).id)
        for (const ref of playlist.tracks) {
          const trackId = findTrackId(ref)
          if (!trackId) {
            result.tracksMissing += 1
            continue
          }
          const inPlaylist = this.db.prepare(
            'SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ? LIMIT 1'
          ).get(playlistId, trackId)
          if (!inPlaylist) {
            this.addTrackToPlaylist(playlistId, trackId)
            result.tracksAdded += 1
          }
        }
      }
      for (const ref of data.favorites) {
        const trackId = findTrackId(ref)
        if (!trackId) {
          result.tracksMissing += 1
          continue
        }
        if (this.isFavorite(trackId)) {
          result.favoritesExisting += 1
        } else {
          this.addFavorite(trackId)
          result.favoritesAdded += 1
        }
      }
    })
    return result
  }

  upsertSongMeta(input: SongMetaInput): SongMeta {
    const path = input.path.trim() || input.title.trim()
    const title = input.title.trim() || path
    if (!path || !title) throw new Error('歌曲路径或标题不能为空。')
    const now = Date.now()
    if (!input.found) {
      // 新检索未找到时保留此前的成功缓存：不覆盖、不删除，仅返回本次结果（不落库），响应语义不变。
      const existing = this.getSongMetaByPath(path)
      if (existing && existing.found) {
        return {
          id: existing.id,
          path,
          title,
          intro: input.intro,
          lyrics: input.lyricsBilingual.length > 0 ? input.lyricsBilingual : input.lyrics,
          lyricsBilingual: input.lyricsBilingual,
          source: input.source,
          model: input.model,
          found: false,
          reason: input.reason,
          updatedAt: now
        }
      }
    }
    const id = randomUUID()
    const lyricsBilingual = JSON.stringify(input.lyricsBilingual)
    this.db.prepare(`
      INSERT INTO song_meta (
        id, path, title, intro, lyrics, lyrics_bilingual, source, model, found, reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        intro = excluded.intro,
        lyrics = excluded.lyrics,
        lyrics_bilingual = excluded.lyrics_bilingual,
        source = excluded.source,
        model = excluded.model,
        found = excluded.found,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `).run(
      id,
      path,
      title,
      input.intro,
      input.lyrics,
      lyricsBilingual,
      input.source,
      input.model,
      input.found ? 1 : 0,
      input.reason ?? null,
      now
    )
    const row = this.db.prepare(`
      SELECT id, path, title, intro, lyrics, lyrics_bilingual, source, model, found, reason, updated_at
      FROM song_meta WHERE path = ? LIMIT 1
    `).get(path) as SongMetaDbRow | undefined
    if (!row) throw new Error('无法保存歌曲信息。')
    return songMetaFromRow(row)
  }

  getSongMeta(identifier: string): SongMeta | null {
    const value = identifier.trim()
    if (!value) return null
    const row = this.db.prepare(`
      SELECT id, path, title, intro, lyrics, lyrics_bilingual, source, model, found, reason, updated_at
      FROM song_meta
      WHERE id = ? OR path = ? OR title = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(value, value, value) as SongMetaDbRow | undefined
    return row ? songMetaFromRow(row) : null
  }

  private getSongMetaByPath(path: string): SongMeta | null {
    const row = this.db.prepare(`
      SELECT id, path, title, intro, lyrics, lyrics_bilingual, source, model, found, reason, updated_at
      FROM song_meta WHERE path = ? LIMIT 1
    `).get(path) as SongMetaDbRow | undefined
    return row ? songMetaFromRow(row) : null
  }

  // ---- 歌曲检索任务（song_info_tasks）持久化 ----

  insertSongInfoTask(input: SongInfoTaskInput): SongInfoTask {
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO song_info_tasks (
        id, track_id, prompt, path, title, artist, source, model, status, started_at,
        finished_at, tool_call_count, current_tool, message, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, 0, NULL, NULL, NULL)
    `).run(
      id,
      input.trackId,
      input.prompt,
      input.path,
      input.title,
      input.artist,
      input.source,
      input.model,
      now
    )
    const task = this.getSongInfoTask(id)
    if (!task) throw new Error('无法创建检索任务。')
    return task
  }

  getSongInfoTask(id: string): SongInfoTask | null {
    const row = this.db.prepare(`
      SELECT ${SONG_INFO_TASK_SUMMARY_COLUMNS} FROM song_info_tasks WHERE id = ? LIMIT 1
    `).get(id) as SongInfoTaskSummaryRow | undefined
    return row ? songInfoTaskFromRow(row) : null
  }

  getSongInfoTaskRow(id: string): SongInfoTaskRow | null {
    const row = this.db.prepare(`
      SELECT ${SONG_INFO_TASK_COLUMNS} FROM song_info_tasks WHERE id = ? LIMIT 1
    `).get(id) as SongInfoTaskRow | undefined
    return row ?? null
  }

  /** 全部运行中 + 最近 100 条已结束（按结束时间倒序；rowid 作稳定 tie-breaker）。 */
  listSongInfoTasks(): SongInfoTask[] {
    const running = this.db.prepare(`
      SELECT ${SONG_INFO_TASK_SUMMARY_COLUMNS} FROM song_info_tasks
      WHERE status = 'running' ORDER BY started_at DESC, rowid DESC
    `).all() as unknown as SongInfoTaskSummaryRow[]
    const finished = this.db.prepare(`
      SELECT ${SONG_INFO_TASK_SUMMARY_COLUMNS} FROM song_info_tasks
      WHERE status != 'running' ORDER BY finished_at DESC, rowid DESC LIMIT 100
    `).all() as unknown as SongInfoTaskSummaryRow[]
    return [...running, ...finished].map(songInfoTaskFromRow)
  }

  findRunningSongInfoTaskByTrack(trackId: string): SongInfoTask | null {
    const row = this.db.prepare(`
      SELECT ${SONG_INFO_TASK_SUMMARY_COLUMNS} FROM song_info_tasks
      WHERE track_id = ? AND status = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(trackId) as SongInfoTaskSummaryRow | undefined
    return row ? songInfoTaskFromRow(row) : null
  }

  updateSongInfoTaskProgress(id: string, toolCallCount: number, currentTool: string | null): void {
    this.db.prepare(`
      UPDATE song_info_tasks SET tool_call_count = ?, current_tool = ?
      WHERE id = ? AND status = 'running'
    `).run(toolCallCount, currentTool, id)
  }

  /** 仅 running → 终态；返回是否实际转换（并发安全）。 */
  finishSongInfoTask(
    id: string,
    status: SongInfoTaskStatus,
    finishedAt: number,
    message: string | null,
    resultJson: string | null
  ): boolean {
    const info = this.db.prepare(`
      UPDATE song_info_tasks
      SET status = ?, finished_at = ?, message = ?, result_json = ?, current_tool = NULL
      WHERE id = ? AND status = 'running'
    `).run(status, finishedAt, message, resultJson, id)
    return info.changes > 0
  }

  setSongInfoTaskMessage(id: string, message: string): void {
    this.db.prepare('UPDATE song_info_tasks SET message = ? WHERE id = ?').run(message, id)
  }

  /** 删除已结束任务（running 不删）；不影响 song_meta 缓存。 */
  deleteSongInfoTask(id: string): boolean {
    const info = this.db.prepare(`
      DELETE FROM song_info_tasks WHERE id = ? AND status != 'running'
    `).run(id)
    return info.changes > 0
  }

  /** 上一进程遗留的 running 任务不可能继续，标记为 interrupted。 */
  interruptRunningSongInfoTasks(now: number, message: string): number {
    const info = this.db.prepare(`
      UPDATE song_info_tasks
      SET status = 'interrupted', finished_at = ?, message = ?, current_tool = NULL
      WHERE status = 'running'
    `).run(now, message)
    return Number(info.changes)
  }

  /** 任务结果快照（原始检索结果）；无快照或损坏返回 null。 */
  getSongInfoTaskResult(id: string): SongMeta | null {
    const row = this.db.prepare('SELECT result_json FROM song_info_tasks WHERE id = ? LIMIT 1').get(id) as
      | { result_json: string | null }
      | undefined
    if (!row?.result_json) return null
    try {
      const parsed = JSON.parse(row.result_json) as SongMeta
      return parsed && typeof parsed === 'object' && typeof parsed.title === 'string' ? parsed : null
    } catch {
      return null
    }
  }
}

function runInTransaction(db: LibraryDatabase, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function normalizeRootPrefix(rootPath: string): string {
  if (rootPath === '/') return '/'
  return rootPath.replace(/\/+$/, '') || '/'
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, char => `\\${char}`)
}

function rootPathFilter(rootPath: string): { sql: string; params: string[] } {
  const root = normalizeRootPrefix(rootPath)
  if (root === '/') return { sql: "path LIKE '/%'", params: [] }
  return {
    sql: "(path = ? OR path LIKE ? ESCAPE '\\')",
    params: [root, `${escapeLike(root)}/%`]
  }
}
