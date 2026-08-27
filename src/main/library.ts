import { randomUUID } from 'crypto'
import { basename, extname } from 'path'
import type { LibraryDatabase } from './library-db'
import type {
  CloudEntry,
  PlaybackQueueState,
  PlaylistSummary,
  RepeatMode,
  Track,
  TrackDetail,
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
}

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
    playbackUrl: trackPlaybackUrl(row.id)
  }
}

export function rowToTrackDetail(row: TrackRow): TrackDetail {
  return {
    ...rowToTrack(row),
    path: row.path,
    size: row.size,
    modifiedAt: row.modified_at,
    md5: row.md5,
    remoteId: row.remote_id
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

export class LibraryService {
  private lastSyncToken = Date.now()

  constructor(private readonly db: LibraryDatabase) {}

  createSyncToken(): number {
    this.lastSyncToken = Math.max(Date.now(), this.lastSyncToken + 1)
    return this.lastSyncToken
  }

  getTrackRow(id: string): TrackRow | null {
    const row = this.db.prepare(`
      SELECT id, source_id, remote_id, path, title, artist, duration_sec, size,
             modified_at, md5, is_deleted
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
    search = ''
  ): TracksPage {
    const trimmed = search.trim()
    const params: Array<string | number> = []
    let where = 'is_deleted = 0'
    if (sourceId !== 'all') {
      where = 'source_id = ? AND is_deleted = 0'
      params.push(sourceId)
    }
    if (trimmed) {
      where += ' AND title LIKE ? ESCAPE \'\\\''
      params.push(`%${trimmed.replace(/[%_\\]/g, char => `\\${char}`)}%`)
    }

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS count FROM tracks WHERE ${where}`
    ).get(...params) as { count: number }

    params.push(limit, offset)
    const rows = this.db.prepare(`
      SELECT id, source_id, remote_id, path, title, artist, duration_sec, size,
             modified_at, md5, is_deleted
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
      SELECT id, source_id, remote_id, path, title, artist, duration_sec, size,
             modified_at, md5, is_deleted
      FROM tracks
      WHERE ${where}
      ORDER BY title COLLATE NOCASE ASC
    `).all(...params) as unknown as TrackRow[]
    return rows.map(rowToTrack)
  }

  upsertLocalTrack(filePath: string): Track {
    const now = Date.now()
    const title = basename(filePath, extname(filePath))
    const existing = this.db.prepare(`
      SELECT id FROM tracks WHERE source_id = 'local' AND path = ? LIMIT 1
    `).get(filePath) as { id: string } | undefined

    if (existing) {
      this.db.prepare(`
        UPDATE tracks SET title = ?, updated_at = ?, is_deleted = 0 WHERE id = ?
      `).run(title, now, existing.id)
      const row = this.getTrackRow(existing.id)
      if (!row) throw new Error('无法更新本地曲目。')
      return rowToTrack(row)
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
      SELECT t.id, t.source_id, t.remote_id, t.path, t.title, t.artist, t.duration_sec,
             t.size, t.modified_at, t.md5, t.is_deleted
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
      SELECT t.id, t.source_id, t.remote_id, t.path, t.title, t.artist, t.duration_sec,
             t.size, t.modified_at, t.md5, t.is_deleted
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

  upsertSongMeta(input: SongMetaInput): SongMeta {
    const path = input.path.trim() || input.title.trim()
    const title = input.title.trim() || path
    if (!path || !title) throw new Error('歌曲路径或标题不能为空。')
    const now = Date.now()
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
