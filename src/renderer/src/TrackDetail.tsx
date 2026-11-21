import { useEffect, useState } from 'react'
import type { IPCApi, SongInfoMeta, SongInfoTask, Track, TrackDetail as TrackDetailData } from '@shared/ipc'
import ActionNotice, { problemHint } from './ActionNotice'
import AppDialog from './AppDialog'
import MusicBrainzIdentify from './MusicBrainzIdentify'
import SongInfoResult from './SongInfoResult'
import { trackSourceLabel } from './sourceLabels'

type TrackDetailApi = Pick<IPCApi, 'trackGetDetail' | 'songInfoGet' | 'songInfoLookup' |
  'musicBrainzLookup' | 'trackApplyIdentification'> &
  Partial<Pick<IPCApi, 'trackDownload'>>

interface TrackDetailProps {
  track: Track
  api?: TrackDetailApi
  tasks: SongInfoTask[]
  onOpenTasks(history?: boolean): void
  onRefreshTasks(): void
  onBack(): void
  onPlay(): void
  /** 识别结果写入后通知外层刷新曲库列表。 */
  onLibraryChanged?(): void
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '未知'
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60)
  return `${minutes}:${remaining.toString().padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function extensionOf(path: string): string {
  const last = path.lastIndexOf('.')
  if (last <= 0 || last === path.length - 1) return ''
  return path.slice(last + 1).toUpperCase()
}

type CopyField = 'path' | 'remoteId'

export default function TrackDetail({ track, tasks, onOpenTasks, onRefreshTasks, onBack, onPlay, onLibraryChanged, api = window.api }: TrackDetailProps) {
  const [detail, setDetail] = useState<TrackDetailData | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  const [detailRequest, setDetailRequest] = useState(0)
  const [copiedField, setCopiedField] = useState<CopyField | null>(null)
  const [songMeta, setSongMeta] = useState<SongInfoMeta | null>(null)
  const [readingMeta, setReadingMeta] = useState(true)
  const [metaFailed, setMetaFailed] = useState(false)
  const [metaRequest, setMetaRequest] = useState(0)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadStatus, setDownloadStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [startingLookup, setStartingLookup] = useState(false)
  const [lookupError, setLookupError] = useState(false)
  const [dismissedTask, setDismissedTask] = useState<string | null>(null)
  const [detailSection, setDetailSection] = useState<'info' | 'file'>('info')
  const [showResult, setShowResult] = useState(false)

  const currentTask = tasks.find(task => task.trackId === track.id && task.status === 'running')
  const lastTask = tasks.find(task => task.trackId === track.id && task.status !== 'running')
  const lastResultTask = tasks.find(task => task.trackId === track.id && (task.status === 'succeeded' || task.status === 'not_found'))?.id
  // 检索可能顺带补全了标题/艺术家：任务进入终态后重读 detail，避免继续展示列表传来的旧 track。
  const lastTaskKey = lastTask ? `${lastTask.id}:${lastTask.status}:${lastTask.finishedAt ?? 0}` : ''

  useEffect(() => {
    let active = true
    void api.trackGetDetail(track.id).then(found => {
      if (!active) return
      setDetail(found)
      setDetailFailed(!found)
    }, () => { if (active) setDetailFailed(true) })
    return () => { active = false }
  }, [api, track.id, detailRequest, lastTaskKey])

  const path = detail?.path ?? null
  useEffect(() => {
    if (!path) return
    let active = true
    setReadingMeta(true)
    setMetaFailed(false)
    void api.songInfoGet(path).then(meta => {
      if (active) setSongMeta(meta)
    }, () => { if (active) setMetaFailed(true) }).finally(() => { if (active) setReadingMeta(false) })
    return () => { active = false }
  }, [api, path, lastResultTask, metaRequest])

  const duration = track.durationSec ?? detail?.durationSec ?? null
  const size = detail?.size ?? null
  const modifiedAt = detail?.modifiedAt ?? null
  const remoteId = detail?.remoteId ?? null
  // detail 比列表里的 track 更新（AI 可能刚补全），展示以 detail 为准。
  const title = detail?.title || track.title
  const artist = detail?.artist || track.artist

  async function downloadToLocal(): Promise<void> {
    if (downloadBusy || !api.trackDownload) return
    setDownloadBusy(true)
    setDownloadStatus(null)
    try {
      const result = await api.trackDownload(track.id)
      setDownloadStatus({ ok: true, message: result.path })
    } catch (error) {
      setDownloadStatus({ ok: false, message: problemHint(error) })
    } finally {
      setDownloadBusy(false)
    }
  }

  async function startLookup(): Promise<void> {
    if (startingLookup || currentTask) return
    setLookupError(false)
    setStartingLookup(true)
    try {
      await api.songInfoLookup(track.id)
      onRefreshTasks()
    } catch {
      setLookupError(true)
    } finally {
      setStartingLookup(false)
    }
  }

  async function copyValue(value: string, field: CopyField): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = value
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        try {
          textarea.select()
          if (!document.execCommand('copy')) throw new Error('复制失败')
        } finally {
          textarea.remove()
        }
      }
      setCopiedField(field)
    } catch {
      setCopiedField(null)
    }
  }

  return (
    <div className="track-detail">
      <div className="detail-header">
        <button className="quiet-button" onClick={onBack}>‹ 返回</button>
      </div>

      <div className="detail-hero">
        {detail?.coverUrl
          ? <img className="detail-cover" src={detail.coverUrl} alt="专辑封面" />
          : <div className="detail-cover" aria-hidden="true">♪</div>}
        <div className="detail-info">
          <p>{artist ?? trackSourceLabel(track.sourceId)}</p>
          <div className="detail-actions">
            <button className="primary-button" onClick={onPlay}>播放</button>
            {api.trackDownload && (
              <button
                type="button"
                className="quiet-button"
                onClick={() => void downloadToLocal()}
                disabled={downloadBusy}
              >
                {downloadBusy ? '下载中…' : '下载'}
              </button>
            )}
          </div>
        </div>
      </div>

      {downloadStatus && (
        <ActionNotice title={downloadStatus.ok ? '下载完成' : '无法下载音频'} message={downloadStatus.message}
          tone={downloadStatus.ok ? 'success' : 'error'} onDismiss={() => setDownloadStatus(null)} />
      )}
      <div className="detail-sections" role="group" aria-label="曲目详情分类">
        <button type="button" aria-pressed={detailSection === 'info'} onClick={() => setDetailSection('info')}>歌曲信息</button>
        <button type="button" aria-pressed={detailSection === 'file'} onClick={() => setDetailSection('file')}>文件资料</button>
      </div>

      {detailSection === 'file' && (detailFailed ? (
        <ActionNotice title="无法读取文件资料" action={{ label: '重试', run: () => { setDetailFailed(false); setDetailRequest(key => key + 1) } }} />
      ) : <dl className="detail-meta">
        <div className="detail-meta-row">
          <dt>时长</dt>
          <dd>{formatDuration(duration)}</dd>
        </div>
        <div className="detail-meta-row">
          <dt>来源</dt>
          <dd>{trackSourceLabel(track.sourceId)}</dd>
        </div>
        <div className="detail-meta-row">
          <dt>文件 ID</dt>
          <dd className="detail-value-with-action">
            <span className="detail-mono">{detail ? remoteId ?? '无（本地文件）' : '载入中…'}</span>
            {remoteId && (
              <button
                type="button"
                className="quiet-button detail-copy-button"
                onClick={() => void copyValue(remoteId, 'remoteId')}
                aria-label="复制文件 ID"
              >
                {copiedField === 'remoteId' ? '已复制' : '复制'}
              </button>
            )}
          </dd>
        </div>
        <div className="detail-meta-row">
          <dt>格式</dt>
          <dd>{path ? extensionOf(path) || '未知' : '未知'}</dd>
        </div>
        <div className="detail-meta-row">
          <dt>大小</dt>
          <dd>{formatSize(size ?? 0)}</dd>
        </div>
        <div className="detail-meta-row">
          <dt>修改时间</dt>
          <dd>{modifiedAt ? new Date(modifiedAt).toLocaleString() : '未知'}</dd>
        </div>
        <div className="detail-meta-row detail-path-row">
          <dt>路径</dt>
          <dd className="detail-value-with-action">
            <span className="detail-path">{path ?? '未知'}</span>
            {path && (
              <button
                type="button"
                className="quiet-button detail-copy-button"
                onClick={() => void copyValue(path, 'path')}
                aria-label="复制文件路径"
              >
                {copiedField === 'path' ? '已复制' : '复制'}
              </button>
            )}
          </dd>
        </div>
      </dl>)}

      {detailSection === 'info' && (
        <section className="song-info" aria-label="歌曲介绍与歌词">
          <MusicBrainzIdentify detail={detail} api={api} onApplied={updated => {
            setDetail(updated)
            setDetailRequest(key => key + 1)
            onLibraryChanged?.()
          }} />
          <div className="song-info-header">
            <div>
              <h3>介绍与歌词</h3>
              <p className="ai-field-note">使用大模型联网检索，可在后台运行。</p>
            </div>
            <button type="button" className={songMeta?.found ? 'quiet-button' : 'primary-button'}
              onClick={() => void startLookup()} disabled={startingLookup || !!currentTask}>
              {startingLookup ? '正在启动…' : currentTask ? '检索中…' : songMeta?.found ? '重新检索' : 'AI 联网检索'}
            </button>
          </div>
          {lookupError && (
            <ActionNotice title="未能启动检索" message="检查曲目是否仍在库中，或稍后重试。"
              onDismiss={() => setLookupError(false)} />
          )}
          {currentTask ? (
            <div className="detail-ai-progress">
              <span className="notice-spinner" aria-hidden="true" />
              <div><strong>正在联网检索</strong><p className="ai-field-note">
                {currentTask.toolCallCount ? `已调用检索工具 ${currentTask.toolCallCount} 次。` : '正在等待模型响应。'}可以离开此页。
              </p></div>
              <button type="button" className="quiet-button" onClick={() => onOpenTasks()}>查看任务</button>
            </div>
          ) : lastTask && ['failed', 'not_found', 'interrupted'].includes(lastTask.status) && lastTask.id !== dismissedTask ? (
            <ActionNotice title={lastTask.status === 'not_found' ? '上次未找到歌曲信息' : '上次检索未完成'}
              message={lastTask.status !== 'not_found' ? lastTask.message ?? undefined : undefined}
              action={{ label: '查看历史', run: () => onOpenTasks(true) }} onDismiss={() => setDismissedTask(lastTask.id)} />
          ) : null}
          {songMeta?.found ? (
            <div className="detail-ai-summary">
              <div><strong>已有歌曲资料</strong><p className="ai-field-note">更新于 {new Date(songMeta.updatedAt).toLocaleString()}</p></div>
              <button type="button" className="quiet-button" onClick={() => setShowResult(true)}>查看介绍与歌词</button>
            </div>
          ) : metaFailed ? (
            <ActionNotice title="未能读取已保存的结果" action={{ label: '重试', run: () => setMetaRequest(value => value + 1) }} />
          ) : (
            <p className="song-info-empty">{readingMeta && !detailFailed ? '正在读取已保存的歌曲资料…' : '暂无已保存的歌曲资料。'}</p>
          )}
        </section>
      )}
      {showResult && songMeta && (
        <AppDialog title={title} onClose={() => setShowResult(false)}>
          <SongInfoResult meta={songMeta} />
        </AppDialog>
      )}
    </div>
  )
}
