import { randomUUID } from 'crypto'
import { basename, extname } from 'path'
import type Database from 'better-sqlite3'
import type { CloudEntry, PlaylistSummary, Track, TracksPage } from '../shared/ipc'

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

export class LibraryService {
  constructor(private readonly db: Database.Database) {}

  getTrackRow(id: string): TrackRow | null {
    const row = this.db.prepare(`
      SELECT id, source_id, remote_id, path, title, artist, duration_sec, size,
             modified_at, md5, is_deleted
      FROM tracks
      WHERE id = ? AND is_deleted = 0
    `).get(id) as TrackRow | undefined
    return row ?? null
  }

  resolveMedia(id: string): { kind: 'local' | 'baidu'; path: string } | null {
    const row = this.getTrackRow(id)
    if (!row) return null
    if (row.source_id === 'local') return { kind: 'local', path: row.path }
    if (row.source_id === 'baidu') return { kind: 'baidu', path: row.path }
    return null
  }

  listTracksPage(
    sourceId: string,
    offset: number,
    limit: number,
    search = ''
  ): TracksPage {
    const trimmed = search.trim()
    const params: Array<string | number> = [sourceId]
    let where = 'source_id = ? AND is_deleted = 0'
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
    `).all(...params) as TrackRow[]

    return {
      tracks: rows.map(rowToTrack),
      total: totalRow.count,
      offset,
      limit
    }
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

  upsertBaiduTrack(entry: CloudEntry, syncToken: number): string {
    const now = Date.now()
    const remoteId = entry.id
    const title = basename(entry.name, extname(entry.name))

    const byRemote = this.db.prepare(`
      SELECT id FROM tracks
      WHERE source_id = 'baidu' AND remote_id = ? LIMIT 1
    `).get(remoteId) as { id: string } | undefined

    if (byRemote) {
      this.db.prepare(`
        UPDATE tracks SET
          path = ?, title = ?, size = ?, modified_at = ?,
          is_deleted = 0, last_seen_sync = ?, updated_at = ?
        WHERE id = ?
      `).run(entry.path, title, entry.size, entry.modifiedAt, syncToken, now, byRemote.id)
      return byRemote.id
    }

    const byPath = this.db.prepare(`
      SELECT id FROM tracks WHERE source_id = 'baidu' AND path = ? LIMIT 1
    `).get(entry.path) as { id: string } | undefined

    if (byPath) {
      this.db.prepare(`
        UPDATE tracks SET
          remote_id = ?, title = ?, size = ?, modified_at = ?,
          is_deleted = 0, last_seen_sync = ?, updated_at = ?
        WHERE id = ?
      `).run(remoteId, title, entry.size, entry.modifiedAt, syncToken, now, byPath.id)
      return byPath.id
    }

    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO tracks (
        id, source_id, remote_id, path, title, artist, duration_sec, size,
        modified_at, md5, is_deleted, last_seen_sync, created_at, updated_at
      ) VALUES (?, 'baidu', ?, ?, ?, NULL, NULL, ?, ?, NULL, 0, ?, ?, ?)
    `).run(id, remoteId, entry.path, title, entry.size, entry.modifiedAt, syncToken, now, now)
    return id
  }

  markBaiduRootStale(rootPath: string, syncToken: number): void {
    const prefix = normalizeRootPrefix(rootPath)
    this.db.prepare(`
      UPDATE tracks SET last_seen_sync = NULL
      WHERE source_id = 'baidu' AND path LIKE ? ESCAPE '\\'
    `).run(`${escapeLike(prefix)}%`)
    void syncToken
  }

  finalizeBaiduRootSync(rootPath: string, syncToken: number): number {
    const prefix = normalizeRootPrefix(rootPath)
    const result = this.db.prepare(`
      UPDATE tracks SET is_deleted = 1, updated_at = ?
      WHERE source_id = 'baidu'
        AND path LIKE ? ESCAPE '\\'
        AND (last_seen_sync IS NULL OR last_seen_sync != ?)
    `).run(Date.now(), `${escapeLike(prefix)}%`, syncToken)
    return result.changes
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

  listLibraryRoots(sourceId: string): LibraryRootRow[] {
    return this.db.prepare(`
      SELECT id, source_id, root_path, playlist_id, last_sync_at, last_sync_status
      FROM library_roots
      WHERE source_id = ?
      ORDER BY (last_sync_at IS NULL), last_sync_at DESC
    `).all(sourceId) as LibraryRootRow[]
  }

  trackIdsUnderBaiduRoot(rootPath: string): string[] {
    const prefix = normalizeRootPrefix(rootPath)
    const rows = this.db.prepare(`
      SELECT id FROM tracks
      WHERE source_id = 'baidu' AND is_deleted = 0 AND path LIKE ? ESCAPE '\\'
      ORDER BY title COLLATE NOCASE ASC
    `).all(`${escapeLike(prefix)}%`) as Array<{ id: string }>
    return rows.map(row => row.id)
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
    if (result.changes === 0) throw new Error('歌单不存在。')
    const summary = this.listPlaylists().find(playlist => playlist.id === id)
    if (!summary) throw new Error('歌单不存在。')
    return summary
  }

  deletePlaylist(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id)
      this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
    })()
  }

  listPlaylistTracks(playlistId: string): Track[] {
    const rows = this.db.prepare(`
      SELECT t.id, t.source_id, t.remote_id, t.path, t.title, t.artist, t.duration_sec,
             t.size, t.modified_at, t.md5, t.is_deleted
      FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ? AND t.is_deleted = 0
      ORDER BY pt.position ASC
    `).all(playlistId) as TrackRow[]
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
    this.db.transaction(() => {
      for (const trackId of trackIds) {
        this.addTrackToPlaylist(playlistId, trackId)
      }
    })()
  }

  removeTrackFromPlaylist(playlistId: string, trackId: string): void {
    const now = Date.now()
    this.db.prepare(`
      DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?
    `).run(playlistId, trackId)
    this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId)
  }
}

function normalizeRootPrefix(rootPath: string): string {
  if (rootPath === '/') return '/'
  return rootPath.replace(/\/+$/, '') || '/'
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, char => `\\${char}`)
}
