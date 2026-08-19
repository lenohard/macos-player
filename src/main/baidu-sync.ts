import { basename } from 'path'
import type { BaiduService } from './baidu'
import type { LibraryService } from './library'
import type { BaiduImportResult, SyncProgress, SyncTrackDetail } from '../shared/ipc'

const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'])

function isAudioFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return AUDIO_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

export async function syncBaiduDirectory(
  baidu: BaiduService,
  library: LibraryService,
  rootPath: string,
  playlistName: string,
  emit: (progress: SyncProgress) => void
): Promise<BaiduImportResult> {
  const normalizedRoot = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '') || '/'
  const existing = library.listLibraryRoots('baidu').find(root => root.root_path === normalizedRoot)
  if (existing?.playlist_id) {
    return resyncBaiduDirectory(baidu, library, rootPath, emit)
  }

  const syncToken = library.createSyncToken()
  const playlist = library.createPlaylist(playlistName.trim() || basename(normalizedRoot) || '百度网盘')

  library.markBaiduRootStale(normalizedRoot, syncToken)

  const queue: string[] = [normalizedRoot]
  let directoriesDone = 0
  let tracksUpserted = 0
  const importedTrackIds: string[] = []
  const addedTracks: SyncTrackDetail[] = []
  const updatedTracks: SyncTrackDetail[] = []

  emit({
    phase: 'scanning',
    currentPath: normalizedRoot,
    directoriesDone: 0,
    tracksUpserted: 0
  })

  while (queue.length > 0) {
    const directory = queue.shift()!
    const entries = await baidu.listDirectory(directory)
    directoriesDone += 1

    for (const entry of entries) {
      if (entry.isDirectory) {
        queue.push(entry.path)
        continue
      }
      if (!isAudioFile(entry.name)) continue
      const outcome = library.upsertBaiduTrack(entry, syncToken)
      importedTrackIds.push(outcome.trackId)
      tracksUpserted += 1
      if (outcome.status === 'added') {
        const row = library.getTrackRow(outcome.trackId)
        if (row) addedTracks.push({ id: row.id, title: row.title, artist: row.artist, path: row.path })
      } else if (outcome.status === 'updated') {
        const row = library.getTrackRow(outcome.trackId)
        if (row) {
          updatedTracks.push({
            id: row.id,
            title: row.title,
            artist: row.artist,
            path: row.path,
            previousPath: outcome.previousPath ?? undefined
          })
        }
      }
    }

    if (directoriesDone % 5 === 0 || queue.length === 0) {
      emit({
        phase: 'scanning',
        currentPath: directory,
        directoriesDone,
        tracksUpserted
      })
    }
  }

  const removedTracks = library.finalizeBaiduRootSync(normalizedRoot, syncToken)
  library.replacePlaylistTracks(playlist.id, importedTrackIds)
  library.upsertLibraryRoot('baidu', normalizedRoot, playlist.id)

  const result: BaiduImportResult = {
    rootPath: normalizedRoot,
    playlistId: playlist.id,
    scanned: tracksUpserted,
    added: addedTracks.length,
    updated: updatedTracks.length,
    removed: removedTracks.length,
    addedTracks,
    updatedTracks,
    removedTracks
  }

  emit({
    phase: 'done',
    currentPath: normalizedRoot,
    directoriesDone,
    tracksUpserted,
    message: `同步完成：新增 ${addedTracks.length} · 更新 ${updatedTracks.length} · 移除 ${removedTracks.length}`
  })

  return result
}

export async function resyncBaiduDirectory(
  baidu: BaiduService,
  library: LibraryService,
  rootPath: string,
  emit: (progress: SyncProgress) => void
): Promise<BaiduImportResult> {
  const roots = library.listLibraryRoots('baidu')
  const normalizedRoot = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '') || '/'
  const root = roots.find(item => item.root_path === normalizedRoot)
  if (!root?.playlist_id) {
    throw new Error('该目录尚未导入，请先执行导入。')
  }

  const syncToken = library.createSyncToken()
  library.markBaiduRootStale(normalizedRoot, syncToken)

  const queue: string[] = [normalizedRoot]
  let directoriesDone = 0
  let tracksUpserted = 0
  const seenTrackIds: string[] = []
  const addedTracks: SyncTrackDetail[] = []
  const updatedTracks: SyncTrackDetail[] = []

  emit({
    phase: 'scanning',
    currentPath: normalizedRoot,
    directoriesDone: 0,
    tracksUpserted: 0
  })

  while (queue.length > 0) {
    const directory = queue.shift()!
    const entries = await baidu.listDirectory(directory)
    directoriesDone += 1

    for (const entry of entries) {
      if (entry.isDirectory) {
        queue.push(entry.path)
        continue
      }
      if (!isAudioFile(entry.name)) continue
      const outcome = library.upsertBaiduTrack(entry, syncToken)
      seenTrackIds.push(outcome.trackId)
      tracksUpserted += 1
      if (outcome.status === 'added') {
        const row = library.getTrackRow(outcome.trackId)
        if (row) addedTracks.push({ id: row.id, title: row.title, artist: row.artist, path: row.path })
      } else if (outcome.status === 'updated') {
        const row = library.getTrackRow(outcome.trackId)
        if (row) {
          updatedTracks.push({
            id: row.id,
            title: row.title,
            artist: row.artist,
            path: row.path,
            previousPath: outcome.previousPath ?? undefined
          })
        }
      }
    }

    if (directoriesDone % 5 === 0 || queue.length === 0) {
      emit({
        phase: 'scanning',
        currentPath: directory,
        directoriesDone,
        tracksUpserted
      })
    }
  }

  const playlistId = library.ensurePlaylistForRoot('baidu', normalizedRoot)
  const removedTracks = library.finalizeBaiduRootSync(normalizedRoot, syncToken)
  library.replacePlaylistTracks(playlistId, seenTrackIds)
  library.upsertLibraryRoot('baidu', normalizedRoot, playlistId)

  emit({
    phase: 'done',
    currentPath: normalizedRoot,
    directoriesDone,
    tracksUpserted,
    message: `更新完成：新增 ${addedTracks.length} · 更新 ${updatedTracks.length} · 移除 ${removedTracks.length}`
  })

  return {
    rootPath: normalizedRoot,
    playlistId,
    scanned: tracksUpserted,
    added: addedTracks.length,
    updated: updatedTracks.length,
    removed: removedTracks.length,
    addedTracks,
    updatedTracks,
    removedTracks
  }
}
