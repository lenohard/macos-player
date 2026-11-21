import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { app, type BrowserWindow, type WebContents } from 'electron'
import { PLAYBACK_REMOTE_COMMAND_CHANNEL, type RemoteCommand } from '../shared/ipc'

const ACK_TIMEOUT_MS = 3000
const READY_TIMEOUT_MS = 12000

export class DesktopPlaybackCommands {
  private readonly ready = new WeakSet<WebContents>()
  private readonly readyWaiters = new Map<WebContents, Set<(ok: boolean) => void>>()
  private readonly pending = new Map<string, { sender: WebContents; finish: (ok: boolean) => void }>()

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  markReady(sender: WebContents): void {
    this.ready.add(sender)
    for (const finish of this.readyWaiters.get(sender) ?? []) finish(true)
  }

  reset(sender: WebContents): void {
    this.ready.delete(sender)
    for (const finish of this.readyWaiters.get(sender) ?? []) finish(false)
    for (const item of this.pending.values()) {
      if (item.sender === sender) item.finish(false)
    }
  }

  acknowledge(sender: WebContents, id: string): void {
    const item = this.pending.get(id)
    if (item?.sender === sender) item.finish(true)
  }

  async send(command: RemoteCommand): Promise<boolean> {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return false
    const sender = window.webContents
    if (!this.ready.has(sender)) {
      const ready = await new Promise<boolean>(resolve => {
        const waiters = this.readyWaiters.get(sender) ?? new Set<(ok: boolean) => void>()
        const finish = (ok: boolean): void => {
          clearTimeout(timer)
          waiters.delete(finish)
          if (!waiters.size) this.readyWaiters.delete(sender)
          resolve(ok)
        }
        const timer = setTimeout(() => finish(false), READY_TIMEOUT_MS)
        waiters.add(finish)
        this.readyWaiters.set(sender, waiters)
      })
      if (!ready) return false
    }
    if (sender.isDestroyed() || !this.ready.has(sender)) return false

    const id = randomUUID()
    return new Promise<boolean>(resolve => {
      const finish = (ok: boolean): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), ACK_TIMEOUT_MS)
      this.pending.set(id, { sender, finish })
      try {
        sender.send(PLAYBACK_REMOTE_COMMAND_CHANNEL, { ...command, id })
      } catch {
        finish(false)
      }
    })
  }
}

export function installDesktopCli(): string {
  const source = app.isPackaged
    ? join(process.resourcesPath, 'corner-cli.mjs')
    : join(app.getAppPath(), 'scripts', 'corner-cli.mjs')
  if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('找不到命令行文件，请重新安装 Corner 桌面版。')
  }
  const destination = join(homedir(), '.local', 'bin', 'corner')
  mkdirSync(dirname(destination), { recursive: true })
  const existing = lstatSync(destination, { throwIfNoEntry: false })
  if (existing && !existing.isSymbolicLink()) throw new Error(`安装目标已被其他文件占用：${destination}`)
  if (!existing) {
    symlinkSync(source, destination)
    return destination
  }
  const current = readlinkSync(destination)
  if (current === source) return destination
  if (basename(current) !== 'corner-cli.mjs') throw new Error(`安装目标已被其他程序占用：${destination}`)
  const stagedLink = `${destination}.${randomUUID()}`
  symlinkSync(source, stagedLink)
  try {
    renameSync(stagedLink, destination)
  } finally {
    if (lstatSync(stagedLink, { throwIfNoEntry: false })) unlinkSync(stagedLink)
  }
  return destination
}
