import { lstatSync, realpathSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface LocalTrackFileSnapshot {
  path: string
  rootPath: string
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

export class LocalTrackFileError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = 'LocalTrackFileError'
  }
}

function musicRoot(): string {
  return process.env.CORNER_MUSIC_DIR || '/Volumes/Mote/music'
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath)
  return pathFromRoot !== '' && pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

function rootUnavailable(rootPath: string, error: unknown): LocalTrackFileError {
  const detail = error instanceof Error ? error.message : String(error)
  return new LocalTrackFileError(
    `本地音乐目录不可用（可能未挂载）：${rootPath}；${detail}`,
    409
  )
}

function fileUnavailable(filePath: string, error: unknown): LocalTrackFileError {
  const detail = error instanceof Error ? error.message : String(error)
  return new LocalTrackFileError(`本地音频文件不存在或无法访问：${filePath}；${detail}`, 409)
}

function validateRootSync(): string {
  const requestedRoot = resolve(musicRoot())
  let rootStat
  try {
    rootStat = lstatSync(requestedRoot)
  } catch (error) {
    throw rootUnavailable(requestedRoot, error)
  }
  if (rootStat.isSymbolicLink()) {
    throw new LocalTrackFileError('本地音乐根目录不能是符号链接。', 403)
  }
  if (!rootStat.isDirectory()) {
    throw new LocalTrackFileError('本地音乐根目录不是目录。', 409)
  }
  try {
    return realpathSync(requestedRoot)
  } catch (error) {
    throw rootUnavailable(requestedRoot, error)
  }
}

function validateFileSync(trackPath: string, rootPath: string, requireNonEmpty: boolean): LocalTrackFileSnapshot {
  if (!trackPath.trim() || !isAbsolute(trackPath)) {
    throw new LocalTrackFileError('本地曲目路径必须是绝对路径。', 403)
  }
  const requestedFile = resolve(trackPath)
  let fileStat
  try {
    fileStat = lstatSync(requestedFile)
  } catch (error) {
    throw fileUnavailable(requestedFile, error)
  }
  if (fileStat.isSymbolicLink()) {
    throw new LocalTrackFileError('本地音频文件不能是符号链接。', 403)
  }
  if (!fileStat.isFile()) {
    throw new LocalTrackFileError('本地曲目不是普通文件。', 409)
  }
  if (requireNonEmpty && fileStat.size === 0) {
    throw new LocalTrackFileError('本地音频文件为空，未执行操作。', 409)
  }

  let realFile
  try {
    realFile = realpathSync(requestedFile)
  } catch (error) {
    throw fileUnavailable(requestedFile, error)
  }
  // Scanner-produced paths are canonical. Requiring equality also rejects a
  // symlink in any parent component, not only a symlink at the final component.
  if (realFile !== requestedFile) {
    throw new LocalTrackFileError('本地音频路径包含符号链接或非规范路径，已拒绝。', 403)
  }
  if (!isInsideRoot(rootPath, realFile)) {
    throw new LocalTrackFileError('本地音频文件的实际路径超出音乐根目录，已拒绝。', 403)
  }
  return {
    path: realFile,
    rootPath,
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs
  }
}

export function validateLocalTrackFileSync(
  trackPath: string,
  requireNonEmpty = true
): LocalTrackFileSnapshot {
  return validateFileSync(trackPath, validateRootSync(), requireNonEmpty)
}

export async function validateLocalTrackFile(
  trackPath: string,
  requireNonEmpty = true
): Promise<LocalTrackFileSnapshot> {
  const requestedRoot = resolve(musicRoot())
  let rootStat
  try {
    rootStat = await lstat(requestedRoot)
  } catch (error) {
    throw rootUnavailable(requestedRoot, error)
  }
  if (rootStat.isSymbolicLink()) {
    throw new LocalTrackFileError('本地音乐根目录不能是符号链接。', 403)
  }
  if (!rootStat.isDirectory()) {
    throw new LocalTrackFileError('本地音乐根目录不是目录。', 409)
  }

  let rootPath
  try {
    rootPath = await realpath(requestedRoot)
  } catch (error) {
    throw rootUnavailable(requestedRoot, error)
  }
  if (!trackPath.trim() || !isAbsolute(trackPath)) {
    throw new LocalTrackFileError('本地曲目路径必须是绝对路径。', 403)
  }
  const requestedFile = resolve(trackPath)

  let fileStat
  try {
    fileStat = await lstat(requestedFile)
  } catch (error) {
    throw fileUnavailable(requestedFile, error)
  }
  if (fileStat.isSymbolicLink()) {
    throw new LocalTrackFileError('本地音频文件不能是符号链接。', 403)
  }
  if (!fileStat.isFile()) {
    throw new LocalTrackFileError('本地曲目不是普通文件。', 409)
  }
  if (requireNonEmpty && fileStat.size === 0) {
    throw new LocalTrackFileError('本地音频文件为空，未执行操作。', 409)
  }

  let realFile
  try {
    realFile = await realpath(requestedFile)
  } catch (error) {
    throw fileUnavailable(requestedFile, error)
  }
  if (realFile !== requestedFile) {
    throw new LocalTrackFileError('本地音频路径包含符号链接或非规范路径，已拒绝。', 403)
  }
  if (!isInsideRoot(rootPath, realFile)) {
    throw new LocalTrackFileError('本地音频文件的实际路径超出音乐根目录，已拒绝。', 403)
  }
  return {
    path: realFile,
    rootPath,
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs
  }
}

export function sameLocalTrackFile(
  left: LocalTrackFileSnapshot,
  right: LocalTrackFileSnapshot
): boolean {
  return left.path === right.path && left.rootPath === right.rootPath &&
    left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

/**
 * A soft-deleted row is a persistent tombstone. A scanner may revive it only
 * when the original canonical file really exists again (for example, after a
 * user restores it from Trash). Missing files and stale scan batches cannot.
 */
export function canRestoreLocalTrackFile(trackPath: string): boolean {
  try {
    validateLocalTrackFileSync(trackPath, false)
    return true
  } catch {
    return false
  }
}
