import { lstat, readdir, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { LibraryService } from './library'

const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav'])
const DIRECTORY_BATCH_SIZE = 50
const UPSERT_BATCH_SIZE = 200

export interface LocalLibraryScanIssue {
  path: string
  operation: 'scan' | 'upsert'
  message: string
}

export interface LocalLibraryScanResult {
  rootPath: string
  directoriesScanned: number
  audioFilesFound: number
  tracksUpserted: number
  skippedSymlinks: number
  issues: LocalLibraryScanIssue[]
}

function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(filePath).toLowerCase())
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath)
  return pathFromRoot === '' || (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Indexes existing audio files only; it never copies audio and never removes,
 * clears, or soft-deletes library rows. Missing/unreadable roots throw before
 * any upsert. Errors below the root are reported and do not stop the scan.
 *
 * Call contract: pass the LibraryService backed by the local service's own
 * database, plus its mounted music root (normally /Volumes/Mote/music).
 * Writes use 200-track transactions; a failed batch rolls back and is reported
 * without retrying individual files or discarding earlier successful batches.
 */
export async function scanLocalLibrary(
  library: LibraryService,
  musicRoot: string
): Promise<LocalLibraryScanResult> {
  if (!musicRoot.trim()) throw new Error('本地音乐目录不能为空。')

  const requestedRoot = resolve(musicRoot)
  let rootPath: string
  try {
    const rootStat = await lstat(requestedRoot)
    if (rootStat.isSymbolicLink()) throw new Error('根目录不能是符号链接。')
    if (!rootStat.isDirectory()) throw new Error('路径不是目录。')
    rootPath = await realpath(requestedRoot)
  } catch (error) {
    throw new Error(`本地音乐目录不可用（可能未挂载）：${requestedRoot}；${messageOf(error)}`)
  }

  const result: LocalLibraryScanResult = {
    rootPath,
    directoriesScanned: 0,
    audioFilesFound: 0,
    tracksUpserted: 0,
    skippedSymlinks: 0,
    issues: []
  }
  const queue = [rootPath]
  const pendingTracks: string[] = []
  let queueIndex = 0

  const flushTracks = (): void => {
    if (pendingTracks.length === 0) return
    const batch = pendingTracks.splice(0, pendingTracks.length)
    try {
      library.upsertLocalTracksBatch(batch)
      result.tracksUpserted += batch.length
    } catch (error) {
      for (const filePath of batch) {
        result.issues.push({
          path: filePath,
          operation: 'upsert',
          message: `本批 ${batch.length} 首已回滚：${messageOf(error)}`
        })
      }
    }
  }

  while (queueIndex < queue.length) {
    const directory = queue[queueIndex++]
    let entries
    try {
      const directoryStat = await lstat(directory)
      if (directoryStat.isSymbolicLink()) {
        result.skippedSymlinks += 1
        continue
      }
      if (!directoryStat.isDirectory()) continue

      const realDirectory = await realpath(directory)
      if (!isInsideRoot(rootPath, realDirectory)) {
        result.issues.push({ path: directory, operation: 'scan', message: '目录实际路径超出音乐根目录，已跳过。' })
        continue
      }
      entries = await readdir(realDirectory, { withFileTypes: true })
      result.directoriesScanned += 1
    } catch (error) {
      result.issues.push({ path: directory, operation: 'scan', message: messageOf(error) })
      continue
    }

    for (let start = 0; start < entries.length; start += DIRECTORY_BATCH_SIZE) {
      const batch = entries.slice(start, start + DIRECTORY_BATCH_SIZE)
      for (const entry of batch) {
        const entryPath = join(directory, entry.name)
        if (entry.isSymbolicLink()) {
          result.skippedSymlinks += 1
          continue
        }
        if (entry.isDirectory()) {
          queue.push(entryPath)
          continue
        }
        // AppleDouble sidecars are metadata, not playable audio files.
        if (!entry.isFile() || entry.name.startsWith('._') || !isAudioFile(entry.name)) continue

        try {
          // Re-check with lstat/realpath so links and paths escaping the root
          // are never passed to LibraryService, even on filesystems whose
          // directory entries do not provide reliable type information.
          const fileStat = await lstat(entryPath)
          if (fileStat.isSymbolicLink()) {
            result.skippedSymlinks += 1
            continue
          }
          if (!fileStat.isFile() || !isAudioFile(entryPath)) continue

          const realFile = await realpath(entryPath)
          if (!isInsideRoot(rootPath, realFile)) {
            result.issues.push({ path: entryPath, operation: 'scan', message: '文件实际路径超出音乐根目录，已跳过。' })
            continue
          }
          result.audioFilesFound += 1
          pendingTracks.push(realFile)
          if (pendingTracks.length === UPSERT_BATCH_SIZE) flushTracks()
        } catch (error) {
          result.issues.push({ path: entryPath, operation: 'scan', message: messageOf(error) })
        }
      }
      // Directory enumeration and SQLite upserts can otherwise monopolize the
      // main process. Yield after every batch, including the final small one.
      await yieldToEventLoop()
    }
  }

  flushTracks()
  return result
}
