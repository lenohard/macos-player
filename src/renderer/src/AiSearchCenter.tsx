import { useEffect, useMemo, useRef, useState } from 'react'
import type { IPCApi, SongInfoMeta, SongInfoTask } from '@shared/ipc'
import ActionNotice from './ActionNotice'
import AppDialog from './AppDialog'
import SongInfoResult from './SongInfoResult'
import './ai-search-center.css'

type AiSearchCenterApi = Pick<IPCApi,
  'songInfoGetTaskResult' | 'songInfoCancelTask' | 'songInfoRetryTask' | 'songInfoDeleteTask'
>

interface AiSearchCenterProps {
  initialTab?: 'running' | 'history'
  api?: AiSearchCenterApi
  tasks: SongInfoTask[]
  loading: boolean
  loadError: boolean
  onRefresh: () => void
  onOpenTrack: (id: string) => Promise<void>
  onOpenSettings?: () => void
}

type CenterTab = 'running' | 'history'
type DialogKind = 'result' | 'details' | 'cancel' | 'delete'
type DialogState = { kind: DialogKind; taskId: string }
type PendingAction = { taskId: string; action: 'retry' | 'cancel' | 'delete' | 'track' }
type NoticeState = { title: string; message?: string; tone: 'error' | 'success' }
type HistoryFilter = 'all' | Exclude<SongInfoTask['status'], 'running'>

const HISTORY_PAGE_SIZE = 10

const STATUS_LABELS: Record<SongInfoTask['status'], string> = {
  running: '检索中',
  succeeded: '已完成',
  not_found: '未找到',
  failed: '失败',
  canceled: '已取消',
  interrupted: '已中断'
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const current = new Date()
  const includeYear = date.getFullYear() !== current.getFullYear()
  return date.toLocaleString('zh-CN', {
    year: includeYear ? 'numeric' : undefined,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function formatFullDate(timestamp: number | null): string {
  return timestamp == null ? '—' : new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function taskDuration(task: SongInfoTask, now: number): number {
  return (task.finishedAt ?? now) - task.startedAt
}

function defaultMessage(task: SongInfoTask): string {
  switch (task.status) {
    case 'running': return '正在检索歌曲信息，状态会自动更新。'
    case 'succeeded': return '检索完成，本次结果已保存。'
    case 'not_found': return '没有找到可靠的歌曲信息。'
    case 'failed': return '检索未完成，可以重试。'
    case 'canceled': return '这次检索已取消。'
    case 'interrupted': return '检索意外中断，可以重试。'
  }
}

function canRetry(task: SongInfoTask): boolean {
  return task.status !== 'running'
}

export default function AiSearchCenter({
  tasks,
  loading,
  loadError,
  onRefresh,
  onOpenTrack,
  onOpenSettings,
  api = window.api,
  initialTab = 'running'
}: AiSearchCenterProps) {
  const [activeTab, setActiveTab] = useState<CenterTab>(initialTab)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all')
  const [historyPage, setHistoryPage] = useState(1)
  const [now, setNow] = useState(() => Date.now())
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [loadErrorDismissed, setLoadErrorDismissed] = useState(false)
  const [resultSnapshot, setResultSnapshot] = useState<{ taskId: string; meta: SongInfoMeta | null } | null>(null)
  const [resultLoading, setResultLoading] = useState(false)
  const [resultError, setResultError] = useState(false)
  const [resultReload, setResultReload] = useState(0)
  const resultCache = useRef(new Map<string, SongInfoMeta | null>())
  const runningTabRef = useRef<HTMLButtonElement>(null)
  const historyTabRef = useRef<HTMLButtonElement>(null)

  const runningTasks = useMemo(
    () => tasks.filter(task => task.status === 'running').sort((a, b) => b.startedAt - a.startedAt),
    [tasks]
  )
  const historyTasks = useMemo(
    () => tasks.filter(task => task.status !== 'running').sort((a, b) => b.startedAt - a.startedAt),
    [tasks]
  )

  const filteredHistory = useMemo(() => {
    const query = historyQuery.trim().toLocaleLowerCase()
    return historyTasks.filter(task => {
      if (historyFilter !== 'all' && task.status !== historyFilter) return false
      if (!query) return true
      return [task.title, task.artist ?? '', task.model]
        .some(value => value.toLocaleLowerCase().includes(query))
    })
  }, [historyTasks, historyFilter, historyQuery])

  const historyPageCount = Math.max(1, Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE))
  const visibleHistory = filteredHistory.slice(
    (historyPage - 1) * HISTORY_PAGE_SIZE,
    historyPage * HISTORY_PAGE_SIZE
  )
  const dialogTask = dialog ? tasks.find(task => task.id === dialog.taskId) ?? null : null
  const resultTaskId = dialog?.kind === 'result' ? dialog.taskId : null

  useEffect(() => {
    if (runningTasks.length === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [runningTasks.length])

  useEffect(() => {
    if (!loadError) setLoadErrorDismissed(false)
  }, [loadError])

  useEffect(() => {
    setHistoryPage(page => Math.min(page, historyPageCount))
  }, [historyPageCount])

  useEffect(() => {
    if (dialog && !dialogTask) setDialog(null)
  }, [dialog, dialogTask])

  useEffect(() => {
    if (!resultTaskId) {
      setResultSnapshot(null)
      setResultLoading(false)
      setResultError(false)
      return
    }

    let active = true
    if (resultCache.current.has(resultTaskId)) {
      setResultSnapshot({ taskId: resultTaskId, meta: resultCache.current.get(resultTaskId) ?? null })
      setResultLoading(false)
      setResultError(false)
      return
    }

    setResultSnapshot(null)
    setResultLoading(true)
    setResultError(false)
    api.songInfoGetTaskResult(resultTaskId)
      .then(meta => {
        if (!active) return
        resultCache.current.set(resultTaskId, meta)
        setResultSnapshot({ taskId: resultTaskId, meta })
      })
      .catch(() => {
        if (active) setResultError(true)
      })
      .finally(() => {
        if (active) setResultLoading(false)
      })
    return () => { active = false }
  }, [api, resultTaskId, resultReload])

  function refresh(): void {
    setLoadErrorDismissed(false)
    onRefresh()
  }

  function selectTab(tab: CenterTab, moveFocus = false): void {
    setActiveTab(tab)
    if (moveFocus) {
      if (tab === 'running') runningTabRef.current?.focus()
      else historyTabRef.current?.focus()
    }
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    selectTab(activeTab === 'running' ? 'history' : 'running', true)
  }

  async function retryTask(task: SongInfoTask): Promise<void> {
    if (pendingAction) return
    setPendingAction({ taskId: task.id, action: 'retry' })
    setNotice(null)
    try {
      await api.songInfoRetryTask(task.id)
      setDialog(null)
      setActiveTab('running')
      setNotice({ title: '已重新开始检索', message: '新任务会显示在「进行中」。', tone: 'success' })
      onRefresh()
    } catch {
      setNotice({ title: '无法重新检索', message: '请稍后重试；原记录和结果不会受影响。', tone: 'error' })
    } finally {
      setPendingAction(null)
    }
  }

  async function cancelTask(task: SongInfoTask): Promise<void> {
    if (pendingAction) return
    setPendingAction({ taskId: task.id, action: 'cancel' })
    setNotice(null)
    try {
      await api.songInfoCancelTask(task.id)
      setDialog(null)
      setNotice({ title: '已请求取消检索', message: '任务状态会在取消完成后更新。', tone: 'success' })
      onRefresh()
    } catch {
      setNotice({ title: '无法取消检索', message: '请稍后重试，任务可能已经在收尾。', tone: 'error' })
      setDialog(null)
    } finally {
      setPendingAction(null)
    }
  }

  async function deleteTask(task: SongInfoTask): Promise<void> {
    if (pendingAction) return
    setPendingAction({ taskId: task.id, action: 'delete' })
    setNotice(null)
    try {
      await api.songInfoDeleteTask(task.id)
      resultCache.current.delete(task.id)
      setDialog(null)
      setNotice({ title: '检索记录已删除', tone: 'success' })
      onRefresh()
    } catch {
      setNotice({ title: '无法删除记录', message: '请稍后重试，记录仍然保留。', tone: 'error' })
      setDialog(null)
    } finally {
      setPendingAction(null)
    }
  }

  async function openTrack(task: SongInfoTask): Promise<void> {
    if (!task.trackId || pendingAction) return
    setPendingAction({ taskId: task.id, action: 'track' })
    setNotice(null)
    try {
      await onOpenTrack(task.trackId)
    } catch {
      setNotice({ title: '无法打开歌曲', message: '曲目可能已移除，请刷新音乐库后重试。', tone: 'error' })
    } finally {
      setPendingAction(null)
    }
  }

  function clearHistoryFilters(): void {
    setHistoryQuery('')
    setHistoryFilter('all')
    setHistoryPage(1)
  }

  function renderTask(task: SongInfoTask) {
    const busy = pendingAction !== null
    const pending = pendingAction?.taskId === task.id ? pendingAction.action : null
    const message = task.message || defaultMessage(task)
    const secondary = task.status === 'running' && task.currentTool
      ? `正在使用 ${task.currentTool}`
      : `${task.status === 'running' ? '已进行' : '耗时'} ${formatDuration(taskDuration(task, now))}`

    return (
      <article className={`ai-task-row ai-task-${task.status}`} key={task.id}>
        <div className="ai-task-copy">
          <div className="ai-task-title-line">
            <strong title={task.title}>{task.title}</strong>
            <span className={`ai-status-badge ai-status-${task.status}`}>
              {task.status === 'running' && <span className="ai-mini-spinner" aria-hidden="true" />}
              {STATUS_LABELS[task.status]}
            </span>
          </div>
          <p className="ai-task-byline" title={`${task.artist ?? '未知艺术家'} · ${task.model}`}>
            <span>{task.artist ?? '未知艺术家'}</span>
            <span aria-hidden="true">·</span>
            <span>{task.model}</span>
          </p>
          <p className="ai-task-message" title={message}>{message}</p>
          {task.status === 'running' && <div className="ai-task-progress" aria-hidden="true" />}
        </div>

        <div className="ai-task-timing">
          <span>{secondary}</span>
          <span>
            {task.toolCallCount > 0
              ? `工具 ${task.toolCallCount} 次`
              : task.status === 'running' ? '尚未调用工具' : '未调用工具'}
          </span>
          <time dateTime={new Date(task.startedAt).toISOString()} title={formatFullDate(task.startedAt)}>
            {formatDate(task.startedAt)}
          </time>
        </div>

        <div className="ai-task-actions" aria-label={`${task.title} 的操作`}>
          <button
            type="button"
            className="quiet-button"
            onClick={() => setDialog({ kind: task.status === 'succeeded' || task.status === 'not_found' ? 'result' : 'details', taskId: task.id })}
          >
            {task.status === 'succeeded' || task.status === 'not_found' ? '查看结果' : '详情'}
          </button>
          {task.trackId && (
            <button type="button" className="quiet-button" disabled={busy} onClick={() => void openTrack(task)}>
              {pending === 'track' ? '打开中…' : '打开歌曲'}
            </button>
          )}
          {task.status === 'running' && (
            <button type="button" className="quiet-button" disabled={busy} onClick={() => setDialog({ kind: 'cancel', taskId: task.id })}>
              取消
            </button>
          )}
          {canRetry(task) && (
            <button type="button" className="quiet-button" disabled={busy} onClick={() => void retryTask(task)}>
              {pending === 'retry' ? '重试中…' : task.status === 'succeeded' ? '重新检索' : '重试'}
            </button>
          )}
          {task.status !== 'running' && (
            <button type="button" className="quiet-button ai-danger-action" disabled={busy} onClick={() => setDialog({ kind: 'delete', taskId: task.id })}>
              删除
            </button>
          )}
        </div>
      </article>
    )
  }

  function renderDialog() {
    if (!dialog || !dialogTask) return null
    const task = dialogTask
    const close = () => setDialog(null)
    const busy = pendingAction?.taskId === task.id
    const openTrackButton = task.trackId && (
      <button type="button" className="quiet-button" disabled={pendingAction !== null} onClick={() => void openTrack(task)}>
        {busy && pendingAction?.action === 'track' ? '打开中…' : '打开歌曲'}
      </button>
    )

    if (dialog.kind === 'cancel' || dialog.kind === 'delete') {
      const deleting = dialog.kind === 'delete'
      const actionBusy = busy && pendingAction?.action === (deleting ? 'delete' : 'cancel')
      return (
        <AppDialog
          key={`${dialog.kind}-${task.id}`}
          compact
          title={deleting ? '删除检索记录？' : '取消这次检索？'}
          onClose={close}
          footer={(
            <>
              <button type="button" className="quiet-button" disabled={actionBusy} onClick={close}>
                {deleting ? '保留记录' : '继续检索'}
              </button>
              <button
                type="button"
                className={`quiet-button${deleting ? ' ai-danger-action' : ''}`}
                disabled={pendingAction !== null}
                onClick={() => void (deleting ? deleteTask(task) : cancelTask(task))}
              >
                {actionBusy ? (deleting ? '删除中…' : '取消中…') : (deleting ? '删除记录' : '取消检索')}
              </button>
            </>
          )}
        >
          <div className="ai-confirm-copy">
            <strong>{task.title}</strong>
            <span>{task.artist ?? '未知艺术家'}</span>
            <p>
              {deleting
                ? '只会删除这次检索记录及其结果快照，不会删除歌曲或修改音频文件。'
                : '取消后仍可在历史记录中查看这次任务，并在需要时重试。'}
            </p>
          </div>
        </AppDialog>
      )
    }

    if (dialog.kind === 'details') {
      return (
        <AppDialog
          key={`details-${task.id}`}
          title={task.title}
          onClose={close}
          footer={<>{openTrackButton}<button type="button" className="primary-button" onClick={close}>关闭</button></>}
        >
          <div className="ai-dialog-context">{task.artist ?? '未知艺术家'} · {STATUS_LABELS[task.status]}</div>
          <p className="ai-dialog-message">{task.message || defaultMessage(task)}</p>
          <dl className="ai-task-detail-list">
            <div><dt>状态</dt><dd><span className={`ai-status-badge ai-status-${task.status}`}>{STATUS_LABELS[task.status]}</span></dd></div>
            <div><dt>模型</dt><dd>{task.model}</dd></div>
            <div><dt>开始时间</dt><dd>{formatFullDate(task.startedAt)}</dd></div>
            <div><dt>结束时间</dt><dd>{formatFullDate(task.finishedAt)}</dd></div>
            <div><dt>耗时</dt><dd>{formatDuration(taskDuration(task, now))}</dd></div>
            <div><dt>工具调用</dt><dd>{task.toolCallCount} 次{task.currentTool ? ` · ${task.currentTool}` : ''}</dd></div>
          </dl>
          {task.status === 'running' && <div className="ai-task-progress ai-dialog-progress" aria-hidden="true" />}
        </AppDialog>
      )
    }

    return (
      <AppDialog
        key={`result-${task.id}`}
        title={`${task.title} · 检索结果`}
        onClose={close}
        footer={<>{openTrackButton}<button type="button" className="primary-button" onClick={close}>关闭</button></>}
      >
        <div className="ai-dialog-context">{task.artist ?? '未知艺术家'} · 本次尝试的结果快照</div>
        {resultLoading && (
          <div className="ai-dialog-result-state" role="status">
            <span className="ai-spinner" aria-hidden="true" />
            <p>正在读取本次检索结果…</p>
          </div>
        )}
        {!resultLoading && resultError && (
          <div className="ai-dialog-result-state">
            <h3>暂时无法读取结果</h3>
            <p>记录仍然保留，请稍后重试。</p>
            <button type="button" className="quiet-button" onClick={() => setResultReload(value => value + 1)}>重新读取</button>
          </div>
        )}
        {!resultLoading && !resultError && resultSnapshot?.taskId === task.id && resultSnapshot.meta && (
          <SongInfoResult meta={resultSnapshot.meta} />
        )}
        {!resultLoading && !resultError && resultSnapshot?.taskId === task.id && !resultSnapshot.meta && (
          <div className="ai-dialog-result-state">
            <h3>本次没有结果快照</h3>
            <p>{task.message || '这次尝试没有保存可展示的结果。'}</p>
          </div>
        )}
      </AppDialog>
    )
  }

  const hasTasks = tasks.length > 0

  return (
    <div className="ai-search-center">
      <div className="ai-center-toolbar">
        <div className="ai-center-tabs" role="tablist" aria-label="检索任务视图">
          <button
            ref={runningTabRef}
            type="button"
            role="tab"
            id="ai-running-tab"
            aria-controls="ai-running-panel"
            aria-selected={activeTab === 'running'}
            tabIndex={activeTab === 'running' ? 0 : -1}
            className={activeTab === 'running' ? 'active' : ''}
            onClick={() => selectTab('running')}
            onKeyDown={handleTabKeyDown}
          >
            进行中 <span>{runningTasks.length}</span>
          </button>
          <button
            ref={historyTabRef}
            type="button"
            role="tab"
            id="ai-history-tab"
            aria-controls="ai-history-panel"
            aria-selected={activeTab === 'history'}
            tabIndex={activeTab === 'history' ? 0 : -1}
            className={activeTab === 'history' ? 'active' : ''}
            onClick={() => selectTab('history')}
            onKeyDown={handleTabKeyDown}
          >
            历史记录 <span>{historyTasks.length}</span>
          </button>
        </div>
        <button type="button" className="quiet-button ai-refresh-button" disabled={loading} onClick={refresh}>
          <svg className={loading ? 'is-spinning' : ''} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13.2 5.1A5.6 5.6 0 1 0 13 11M13.2 5.1V1.9m0 3.2H10" />
          </svg>
          {loading ? '更新中' : '刷新'}
        </button>
      </div>

      {loadError && hasTasks && !loadErrorDismissed && (
        <div className="ai-center-notice">
          <ActionNotice
            title="暂时无法更新检索记录"
            message="当前显示的是已读取的内容。"
            action={{ label: '重试', run: refresh }}
            onDismiss={() => setLoadErrorDismissed(true)}
          />
        </div>
      )}
      {notice && (
        <div className="ai-center-notice">
          <ActionNotice {...notice} onDismiss={() => setNotice(null)} />
        </div>
      )}

      {activeTab === 'history' && hasTasks && (
        <div className="ai-history-filters">
          <div className="search-field ai-history-search">
            <svg className="search-field-icon" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3 3" />
            </svg>
            <input
              type="search"
              value={historyQuery}
              aria-label="搜索历史记录"
              placeholder="搜索歌曲、艺术家或模型"
              onChange={event => { setHistoryQuery(event.target.value); setHistoryPage(1) }}
            />
            {historyQuery && (
              <button type="button" className="search-field-clear" aria-label="清除搜索" onClick={() => { setHistoryQuery(''); setHistoryPage(1) }}>×</button>
            )}
          </div>
          <select
            aria-label="按状态筛选历史记录"
            value={historyFilter}
            onChange={event => { setHistoryFilter(event.target.value as HistoryFilter); setHistoryPage(1) }}
          >
            <option value="all">全部状态</option>
            <option value="succeeded">已完成</option>
            <option value="not_found">未找到</option>
            <option value="failed">失败</option>
            <option value="canceled">已取消</option>
            <option value="interrupted">已中断</option>
          </select>
        </div>
      )}

      {!hasTasks && loadError ? (
        !loadErrorDismissed ? (
          <div className="ai-center-notice ai-initial-notice">
            <ActionNotice
              title="无法读取检索记录"
              message="请检查服务状态后重试。"
              action={{ label: '重新读取', run: refresh }}
              onDismiss={() => setLoadErrorDismissed(true)}
            />
          </div>
        ) : (
          <div className="ai-center-state">
            <h2>检索记录暂不可用</h2>
            <p>可以重新读取，已有歌曲和检索设置不会受影响。</p>
            <button type="button" className="quiet-button" onClick={refresh}>重新读取</button>
          </div>
        )
      ) : !hasTasks && loading ? (
        <div className="ai-center-state" role="status">
          <span className="ai-spinner" aria-hidden="true" />
          <h2>正在读取检索记录</h2>
          <p>任务状态和历史结果会显示在这里。</p>
        </div>
      ) : activeTab === 'running' ? (
        <section id="ai-running-panel" role="tabpanel" aria-labelledby="ai-running-tab" className="ai-center-panel">
          {runningTasks.length > 0 ? (
            <div className="ai-task-list">{runningTasks.map(renderTask)}</div>
          ) : (
            <div className="ai-center-state">
              <span className="ai-state-icon" aria-hidden="true">♪</span>
              <h2>当前没有进行中的检索</h2>
              <p>使用顶部「检索曲目」选择歌曲，或从曲目详情发起检索。</p>
              <div className="ai-state-actions">
                {historyTasks.length > 0 && <button type="button" className="quiet-button" onClick={() => selectTab('history')}>查看历史记录</button>}
                {onOpenSettings && <button type="button" className="quiet-button" onClick={onOpenSettings}>大模型设置</button>}
              </div>
            </div>
          )}
        </section>
      ) : (
        <section id="ai-history-panel" role="tabpanel" aria-labelledby="ai-history-tab" className="ai-center-panel">
          {visibleHistory.length > 0 ? (
            <>
              <div className="ai-task-list">{visibleHistory.map(renderTask)}</div>
              <div className="ai-history-footer">
                <span>
                  {historyQuery || historyFilter !== 'all' ? `筛选出 ${filteredHistory.length} 条 · ` : ''}
                  第 {historyPage} / {historyPageCount} 页
                </span>
                <div>
                  <button type="button" className="quiet-button" disabled={historyPage <= 1} onClick={() => setHistoryPage(page => page - 1)}>上一页</button>
                  <button type="button" className="quiet-button" disabled={historyPage >= historyPageCount} onClick={() => setHistoryPage(page => page + 1)}>下一页</button>
                </div>
              </div>
            </>
          ) : historyTasks.length > 0 ? (
            <div className="ai-center-state">
              <h2>没有匹配的记录</h2>
              <p>试试其他关键词，或清除状态筛选。</p>
              <button type="button" className="quiet-button" onClick={clearHistoryFilters}>清除筛选</button>
            </div>
          ) : (
            <div className="ai-center-state">
              <span className="ai-state-icon" aria-hidden="true">↺</span>
              <h2>还没有检索记录</h2>
              <p>完成、取消或中断的任务都会保留在这里，便于查看和重试。</p>
              {runningTasks.length > 0 && <button type="button" className="quiet-button" onClick={() => selectTab('running')}>返回进行中的任务</button>}
            </div>
          )}
        </section>
      )}

      {renderDialog()}
    </div>
  )
}
