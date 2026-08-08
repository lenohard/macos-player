import { basename } from 'path'
import type { WebDAVService } from './webdav'
import type { LibraryService } from './library'
import type { BaiduImportResult, SyncProgress } from '../shared/ipc'
const AUDIO = new Set(['.aac','.flac','.m4a','.mp3','.ogg','.wav'])
const audio = (name: string) => AUDIO.has((name.slice(name.lastIndexOf('.')) || '').toLowerCase())
export async function syncWebDAVDirectory(provider: WebDAVService, library: LibraryService, rootPath: string, playlistName: string, emit: (p: SyncProgress) => void): Promise<BaiduImportResult> {
  const root = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '') || '/'
  const old = library.listLibraryRoots('quark').find(r => r.root_path === root)
  if (old?.playlist_id) return resyncWebDAVDirectory(provider, library, root, emit)
  const token = Date.now(); const playlist = library.createPlaylist(playlistName.trim() || basename(root) || 'WebDAV')
  library.markCloudRootStale('quark', root, token); const queue = [root]; const ids: string[] = []; let dirs = 0; let count = 0
  emit({ phase:'scanning', currentPath:root, directoriesDone:0, tracksUpserted:0 })
  while (queue.length) { const dir = queue.shift()!; const entries = await provider.listDirectory(dir); dirs++
    for (const e of entries) { if (e.isDirectory) queue.push(e.path); else if (audio(e.name)) { ids.push(library.upsertCloudTrack('quark',e,token)); count++ } }
    if (dirs % 5 === 0 || !queue.length) emit({ phase:'scanning', currentPath:dir, directoriesDone:dirs, tracksUpserted:count })
  }
  const removed = library.finalizeCloudRootSync('quark', root, token); library.addTracksToPlaylist(playlist.id,[...new Set(ids)]); library.upsertLibraryRoot('quark',root,playlist.id)
  emit({phase:'done',currentPath:root,directoriesDone:dirs,tracksUpserted:count,message:`已同步 ${count} 首，移除 ${removed} 首失效记录。`})
  return {rootPath:root,playlistId:playlist.id,scanned:count,added:count,updated:0,removed}
}
export async function resyncWebDAVDirectory(provider: WebDAVService, library: LibraryService, rootPath: string, emit: (p: SyncProgress) => void): Promise<BaiduImportResult> {
  const root = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '') || '/'; const info = library.listLibraryRoots('quark').find(r => r.root_path === root)
  if (!info?.playlist_id) throw new Error('该目录尚未导入，请先执行导入。')
  const token=Date.now(); library.markCloudRootStale('quark',root,token); const queue=[root]; const ids:string[]=[]; let dirs=0; let count=0
  while(queue.length){const dir=queue.shift()!; for(const e of await provider.listDirectory(dir)){if(e.isDirectory)queue.push(e.path);else if(audio(e.name)){ids.push(library.upsertCloudTrack('quark',e,token));count++}} dirs++}
  const removed=library.finalizeCloudRootSync('quark',root,token); library.addTracksToPlaylist(info.playlist_id,[...new Set(ids)]); library.upsertLibraryRoot('quark',root,info.playlist_id)
  emit({phase:'done',currentPath:root,directoriesDone:dirs,tracksUpserted:count,message:`更新完成：${count} 首，移除 ${removed} 首失效记录。`})
  return {rootPath:root,playlistId:info.playlist_id,scanned:count,added:0,updated:count,removed}
}
