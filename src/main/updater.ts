import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import { compare } from 'compare-versions'
import type { UpdateSnapshot } from '../shared/ipc'

const { autoUpdater } = electronUpdater

function formatReleaseNotes(notes: UpdateInfo['releaseNotes']): string {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  if (!Array.isArray(notes)) return String(notes)
  return notes
    .map(note => {
      const title = note.version ? `## ${note.version}` : ''
      const body = note.note ?? ''
      return [title, body].filter(Boolean).join('\n')
    })
    .filter(entry => entry.length > 0)
    .join('\n\n')
}

function toUpdateInfo(info: UpdateInfo): NonNullable<UpdateSnapshot['info']> {
  const rawReleaseDate = info.releaseDate as unknown
  const releaseDate =
    rawReleaseDate instanceof Date
      ? rawReleaseDate.toISOString()
      : typeof rawReleaseDate === 'string'
        ? rawReleaseDate
        : ''
  return {
    version: info.version,
    releaseDate,
    releaseNotes: formatReleaseNotes(info.releaseNotes)
  }
}

function shouldIgnoreRemoteVersion(remoteVersion: string): boolean {
  const currentVersion = app.getVersion()
  if (!remoteVersion) return true
  try {
    return compare(remoteVersion, currentVersion, '<=')
  } catch {
    return true
  }
}

type UpdateState = Omit<UpdateSnapshot, 'appVersion' | 'enabled'>

export class AppUpdater {
  private snapshot: UpdateState = {
    status: 'idle',
    error: null,
    progress: null,
    info: null
  }

  private busy = false

  constructor(private readonly publish: (snapshot: UpdateSnapshot) => void) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('error', error => {
      this.busy = false
      this.patch({ status: 'error', error: error.message, progress: null })
    })

    autoUpdater.on('checking-for-update', () => {
      this.patch({ status: 'checking', error: null, progress: null })
    })

    autoUpdater.on('update-not-available', () => {
      this.busy = false
      this.patch({ status: 'not-available', error: null, progress: null, info: null })
    })

    autoUpdater.on('update-available', info => {
      this.busy = false
      if (shouldIgnoreRemoteVersion(info.version)) {
        this.patch({ status: 'not-available', error: null, progress: null, info: null })
        return
      }
      this.patch({
        status: 'available',
        error: null,
        progress: null,
        info: toUpdateInfo(info)
      })
    })

    autoUpdater.on('download-progress', progress => {
      this.busy = true
      this.patch({
        status: 'downloading',
        error: null,
        progress: progress.percent
      })
    })

    autoUpdater.on('update-downloaded', info => {
      this.busy = false
      this.patch({
        status: 'downloaded',
        error: null,
        progress: 100,
        info: toUpdateInfo(info)
      })
    })
  }

  getSnapshot(): UpdateSnapshot {
    return this.toSnapshot()
  }

  isEnabled(): boolean {
    return app.isPackaged
  }

  scheduleStartupCheck(): void {
    if (!this.isEnabled()) return
    setTimeout(() => {
      void this.checkForUpdates()
    }, 8_000)
  }

  async checkForUpdates(): Promise<UpdateSnapshot> {
    if (!this.isEnabled()) return this.toSnapshot()
    if (this.busy) return this.toSnapshot()
    this.busy = true
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.busy = false
      this.patch({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        progress: null
      })
    }
    return this.toSnapshot()
  }

  async downloadUpdate(): Promise<UpdateSnapshot> {
    if (!this.isEnabled() || this.snapshot.status !== 'available') return this.toSnapshot()
    this.busy = true
    this.patch({ status: 'downloading', error: null, progress: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.busy = false
      this.patch({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        progress: null
      })
    }
    return this.toSnapshot()
  }

  quitAndInstall(): boolean {
    if (this.snapshot.status !== 'downloaded') return false
    autoUpdater.quitAndInstall(false, true)
    return true
  }

  private toSnapshot(): UpdateSnapshot {
    return {
      ...this.snapshot,
      appVersion: app.getVersion(),
      enabled: this.isEnabled()
    }
  }

  private patch(partial: Partial<UpdateState>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    this.publish(this.toSnapshot())
  }
}
