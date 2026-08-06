import { basename } from 'path'
import type { BaiduService } from './baidu'
import type { LibraryService } from './library'
import type { BaiduImportResult, SyncProgress } from '../shared/ipc'

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

  const syncToken = Date.now()
  const playlist = library.createPlaylist(playlistName.trim() || basename(normalizedRoot) || '百度网盘')

  library.markBaiduRootStale(normalizedRoot, syncToken)

  const queue: string[] = [normalizedRoot]
  let directoriesDone = 0
  let tracksUpserted = 0
  const importedTrackIds: string[] = []

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
      const trackId = library.upsertBaiduTrack(entry, syncToken)
      importedTrackIds.push(trackId)
      tracksUpserted += 1
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

  const removed = library.finalizeBaiduRootSync(normalizedRoot, syncToken)
  library.addTracksToPlaylist(playlist.id, [...new Set(importedTrackIds)])
  library.upsertLibraryRoot('baidu', normalizedRoot, playlist.id)

  const result: BaiduImportResult = {
    rootPath: normalizedRoot,
    playlistId: playlist.id,
    scanned: tracksUpserted,
    added: tracksUpserted,
    updated: 0,
    removed
  }

  emit({
    phase: 'done',
    currentPath: normalizedRoot,
    directoriesDone,
    tracksUpserted,
    message: `已同步 ${tracksUpserted} 首，移除 ${removed} 首失效记录。`
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

  const syncToken = Date.now()
  library.markBaiduRootStale(normalizedRoot, syncToken)

  const queue: string[] = [normalizedRoot]
  let directoriesDone = 0
  let tracksUpserted = 0
  const seenTrackIds: string[] = []

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
      const trackId = library.upsertBaiduTrack(entry, syncToken)
      seenTrackIds.push(trackId)
      tracksUpserted += 1
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

  const removed = library.finalizeBaiduRootSync(normalizedRoot, syncToken)
  library.addTracksToPlaylist(root.playlist_id, [...new Set(seenTrackIds)])
  library.upsertLibraryRoot('baidu', normalizedRoot, root.playlist_id)

  emit({
    phase: 'done',
    currentPath: normalizedRoot,
    directoriesDone,
    tracksUpserted,
    message: `更新完成：${tracksUpserted} 首，移除 ${removed} 首失效记录。`
  })

  return {
    rootPath: normalizedRoot,
    playlistId: root.playlist_id,
    scanned: tracksUpserted,
    added: 0,
    updated: tracksUpserted,
    removed
  }
}
