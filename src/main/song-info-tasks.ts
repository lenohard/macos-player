import type { SongInfoMeta, SongInfoTask } from '../shared/ipc'
import type { LibraryService, SongInfoTaskInput, SongInfoTaskRow, SongMeta } from './library'

export type { SongInfoTaskInput, SongInfoTaskRow }

/** 上一进程遗留 running 任务的统一提示。 */
const INTERRUPTED_MESSAGE = '应用退出时任务中断，可重试'

/** 工具进度变化的合并通知窗口（ms）；状态变化立即通知。 */
const PROGRESS_NOTIFY_DEBOUNCE_MS = 300

/**
 * 歌曲检索任务簿记：SQLite 持久化 + 主进程运行态，GUI/CLI 共享。
 * 只负责记录与信号；检索执行、远端中断由 SongInfoService 驱动。
 */
export class SongInfoTaskManager {
  private readonly listeners = new Set<() => void>()
  private progressTimer: NodeJS.Timeout | null = null

  constructor(private readonly library: LibraryService) {
    // 上一进程遗留的 running 任务统一标记为 interrupted；main 对每个 userData 加单实例锁。
    this.library.interruptRunningSongInfoTasks(Date.now(), INTERRUPTED_MESSAGE)
  }

  onTasksChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  list(): SongInfoTask[] {
    return this.library.listSongInfoTasks()
  }

  get(id: string): SongInfoTask | null {
    return this.library.getSongInfoTask(id)
  }

  /** 重试用的完整请求记录（含 prompt/元数据）。 */
  getRecord(id: string): SongInfoTaskRow | null {
    return this.library.getSongInfoTaskRow(id)
  }

  create(input: SongInfoTaskInput): SongInfoTask {
    const task = this.library.insertSongInfoTask(input)
    this.notify(true)
    return task
  }

  findRunningByTrack(trackId: string): SongInfoTask | null {
    return this.library.findRunningSongInfoTaskByTrack(trackId)
  }

  updateProgress(id: string, toolCallCount: number, currentTool: string | null): void {
    this.library.updateSongInfoTaskProgress(id, toolCallCount, currentTool)
    this.notify(false)
  }

  /** 收尾：保存原始结果快照。仅 running → 终态生效（并发安全）。 */
  complete(id: string, result: SongInfoMeta, status: 'succeeded' | 'not_found', message: string | null): boolean {
    const changed = this.library.finishSongInfoTask(id, status, Date.now(), message, JSON.stringify(result))
    if (changed) this.notify(true)
    return changed
  }

  fail(id: string, message: string): boolean {
    const changed = this.library.finishSongInfoTask(id, 'failed', Date.now(), message, null)
    if (changed) this.notify(true)
    return changed
  }

  cancel(id: string, message: string): boolean {
    const changed = this.library.finishSongInfoTask(id, 'canceled', Date.now(), message, null)
    if (changed) this.notify(true)
    return changed
  }

  /** 取消后补充提示（如无法确认远端已停止）。 */
  setMessage(id: string, message: string): void {
    this.library.setSongInfoTaskMessage(id, message)
    this.notify(true)
  }

  /** 删除已结束任务；running 抛错，不影响已缓存歌曲信息。 */
  delete(id: string): void {
    const task = this.library.getSongInfoTask(id)
    if (!task) throw new Error('任务不存在。')
    if (task.status === 'running') throw new Error('任务仍在进行中，无法删除。')
    this.library.deleteSongInfoTask(id)
    this.notify(true)
  }

  getResult(id: string): SongInfoMeta | null {
    return (this.library.getSongInfoTaskResult(id) as SongMeta | null) as SongInfoMeta | null
  }

  private notify(immediate: boolean): void {
    if (immediate) {
      if (this.progressTimer) {
        clearTimeout(this.progressTimer)
        this.progressTimer = null
      }
      this.emit()
      return
    }
    if (this.progressTimer) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      this.emit()
    }, PROGRESS_NOTIFY_DEBOUNCE_MS)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }
  }
}
