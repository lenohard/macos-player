import { basename } from 'path'
import type { WebDAVService } from './webdav'
import type { LibraryService } from './library'
import type { BaiduImportResult, SyncProgress, SyncTrackDetail } from '../shared/ipc'
const AUDIO = new Set(['.aac','.flac','.m4a','.mp3','.ogg','.wav'])
const audio = (name: string) => AUDIO.has((name.slice(name.lastIndexOf('.')) || '').toLowerCase())

function collectChange(
  library: LibraryService,
  outcome: { trackId: string; status: 'added' | 'updated' | 'unchanged'; previousPath: string | null },
  addedTracks: SyncTrackDetail[],
  updatedTracks: SyncTrackDetail[]
): void {
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

export async function syncWebDAVDirectory(provider: WebDAVService, library: LibraryService, rootPath: string, playlistName: string, emit: (p: SyncProgress) => void): Promise<BaiduImportResult> {
  const root = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '') || '/'
  const old = library.listLibraryRoots('quark').find(r => r.root_path === root)
  if (old?.playlist_id) return resyncWebDAVDirectory(provider, library, root, emit)
  const token = library.createSyncToken(); const playlist = library.createPlaylist(playlistName.trim() || basename(root) || 'WebDAV')
  library.markCloudRootStale('quark', root, token); const queue = [root]; const ids: string[] = []; let dirs = 0; let count = 0
  const addedTracks: SyncTrackDetail[] = []; const updatedTracks: SyncTrackDetail[] = []
  emit({ phase:'scanning', currentPath:root, directoriesDone:0, tracksUpserted:0 })
  while (queue.length) { const dir = queue.shift()!; const entries = await provider.listDirectory(dir); dirs++
    for (const e of entries) { if (e.isDirectory) queue.push(e.path); else if (audio(e.name)) { const outcome = library.upsertCloudTrack('quark', e, token); ids.push(outcome.trackId); count++; collectChange(library, outcome, addedTracks, updatedTracks) } }
    if (dirs % 5 === 0 || !queue.length) emit({ phase:'scanning', currentPath:dir, directoriesDone:dirs, tracksUpserted:count })
  }
  const removedTracks = library.finalizeCloudRootSync('quark', root, token); library.replacePlaylistTracks(playlist.id, ids); library.upsertLibraryRoot('quark',root,playlist.id)
  emit({phase:'done',currentPath:root,directoriesDone:dirs,tracksUpserted:count,message:`同步完成：新增 ${addedTracks.length} · 更新 ${updatedTracks.length} · 移除 ${removedTracks.length}`})
  return {rootPath:root,playlistId:playlist.id,scanned:count,added:addedTracks.length,updated:updatedTracks.length,removed:removedTracks.length,addedTracks,updatedTracks,removedTracks}
}
export async function resyncWebDAVDirectory(provider: WebDAVService, library: LibraryService, rootPath: string, emit: (p: SyncProgress) => void): Promise<BaiduImportResult> {
  const root = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '') || '/'; const info = library.listLibraryRoots('quark').find(r => r.root_path === root)
  if (!info?.playlist_id) throw new Error('该目录尚未导入，请先执行导入。')
  const token=library.createSyncToken(); library.markCloudRootStale('quark',root,token); const queue=[root]; const ids:string[]=[]; let dirs=0; let count=0
  const addedTracks: SyncTrackDetail[] = []; const updatedTracks: SyncTrackDetail[] = []
  while(queue.length){const dir=queue.shift()!; for(const e of await provider.listDirectory(dir)){if(e.isDirectory)queue.push(e.path);else if(audio(e.name)){const outcome = library.upsertCloudTrack('quark',e,token); ids.push(outcome.trackId); count++; collectChange(library, outcome, addedTracks, updatedTracks)}} dirs++}
  const playlistId = library.ensurePlaylistForRoot('quark', root)
  const removedTracks=library.finalizeCloudRootSync('quark',root,token); library.replacePlaylistTracks(playlistId,ids); library.upsertLibraryRoot('quark',root,playlistId)
  emit({phase:'done',currentPath:root,directoriesDone:dirs,tracksUpserted:count,message:`更新完成：新增 ${addedTracks.length} · 更新 ${updatedTracks.length} · 移除 ${removedTracks.length}`})
  return {rootPath:root,playlistId,scanned:count,added:addedTracks.length,updated:updatedTracks.length,removed:removedTracks.length,addedTracks,updatedTracks,removedTracks}
}
