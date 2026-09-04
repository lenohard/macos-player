import { existsSync, mkdirSync, statSync } from 'fs'
import { copyFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { homedir } from 'os'
import type { BaiduService } from './baidu'
import type { LibraryService } from './library'
import type { WebDAVService } from './webdav'

export interface DownloadTrackDeps {
  library: LibraryService
  baidu?: BaiduService
  webdav?: WebDAVService
}

export interface TrackDownloadResult {
  path: string
  bytes: number
  source: string
}

/** 替换文件名中的非法字符 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\.+$/, '')
    .trim()
    || 'untitled'
}

/** 自动处理重名：在文件名后加 (1)、(2)… */
function findAvailablePath(dest: string): string {
  if (!existsSync(dest)) return dest
  const dir = dirname(dest)
  const ext = extname(dest)
  const base = basename(dest, ext)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = join(dir, `${base} (${i})${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(dir, `${base}_${Date.now()}${ext}`)
}

/** 下载曲目音频到本地磁盘（local 复制 / baidu、webdav 流式下载），CLI 与 GUI 共用 */
export async function downloadTrack(
  deps: DownloadTrackDeps,
  trackId: string,
  dest = ''
): Promise<TrackDownloadResult> {
  const media = deps.library.resolveMedia(trackId)
  if (!media) throw new Error('曲目不存在。')

  const row = deps.library.getTrackRow(trackId)
  if (!row) throw new Error('曲目不存在。')

  const ext = extname(row.path)
  const safeTitle = sanitizeFilename(row.title)

  // 决定目标路径：dest 可为目标目录或完整文件路径，默认 ~/Downloads
  let destPath: string
  if (dest) {
    try {
      destPath = statSync(dest).isDirectory()
        ? join(dest, `${safeTitle}${ext}`)
        : dest
    } catch {
      destPath = dest
    }
  } else {
    destPath = join(homedir(), 'Downloads', `${safeTitle}${ext}`)
  }
  destPath = findAvailablePath(destPath)

  // 确保父目录存在
  mkdirSync(dirname(destPath), { recursive: true })

  if (media.kind === 'local') {
    await copyFile(media.path, destPath)
  } else if (media.kind === 'baidu') {
    if (!deps.baidu) throw new Error('百度网盘服务不可用。')
    await deps.baidu.download(media.path, destPath)
  } else if (media.kind === 'webdav') {
    if (!deps.webdav) throw new Error('WebDAV 服务不可用。')
    await deps.webdav.download(media.path, destPath)
  } else {
    throw new Error(`不支持的音乐来源：${media.kind}`)
  }

  return { path: destPath, bytes: statSync(destPath).size, source: media.kind }
}
