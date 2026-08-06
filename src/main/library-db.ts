import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

const SCHEMA_VERSION = 1

const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  remote_id TEXT,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT,
  duration_sec REAL,
  size INTEGER NOT NULL DEFAULT 0,
  modified_at INTEGER NOT NULL DEFAULT 0,
  md5 TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  last_seen_sync INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_id, path)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_source_remote
  ON tracks(source_id, remote_id)
  WHERE remote_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tracks_source_active
  ON tracks(source_id, is_deleted, title);

CREATE TABLE IF NOT EXISTS library_roots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  root_path TEXT NOT NULL,
  playlist_id TEXT,
  last_sync_at INTEGER,
  last_sync_status TEXT,
  UNIQUE(source_id, root_path)
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_order
  ON playlist_tracks(playlist_id, position);
`

function migrate(db: Database.Database): void {
  const hasMeta = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'
  `).get() as { name: string } | undefined

  if (hasMeta) {
    const versionRow = db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as
      | { version: number }
      | undefined
    if (versionRow?.version === SCHEMA_VERSION) return
  }

  db.exec('BEGIN')
  try {
    if (!hasMeta) {
      db.exec(MIGRATION_V1)
      db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION)
      db.prepare('INSERT INTO sources (id, type, name) VALUES (?, ?, ?)').run('local', 'local', '本地音乐')
      db.prepare('INSERT INTO sources (id, type, name) VALUES (?, ?, ?)').run('baidu', 'baidu', '百度网盘')
      db.prepare('INSERT INTO sources (id, type, name) VALUES (?, ?, ?)').run('quark', 'quark', '夸克网盘')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function openLibraryDatabase(): Database.Database {
  const dbPath = join(app.getPath('userData'), 'library.sqlite')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export type LibraryDatabase = Database.Database
