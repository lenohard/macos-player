import { useEffect, useRef, useState } from 'react'
import type { SongInfoMeta, SongInfoToolStatus, Track, TrackDetail as TrackDetailData } from '@shared/ipc'
import { trackSourceLabel } from './sourceLabels'

interface TrackDetailProps {
  track: Track
  onBack(): void
  onPlay(): void
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

export default function TrackDetail({ track, onBack, onPlay }: TrackDetailProps) {
  const [detail, setDetail] = useState<TrackDetailData | null>(null)
  const [copiedField, setCopiedField] = useState<CopyField | null>(null)
  const [songMeta, setSongMeta] = useState<SongInfoMeta | null>(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadStatus, setDownloadStatus] = useState('')
  const [lookupId, setLookupId] = useState<string | null>(null)
  const [streamText, setStreamText] = useState('')
  const [toolStatus, setToolStatus] = useState<SongInfoToolStatus | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const lookupIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setSongMeta(null)
    setLookupId(null)
    lookupIdRef.current = null
    setStreamText('')
    setToolStatus(null)
    setLookupError(null)
    window.api.trackGetDetail(track.id)
      .then(found => {
        if (!cancelled) setDetail(found)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [track.id])

  // 详情（含 path）载入后查询已保存的歌曲信息
  useEffect(() => {
    if (!detail) return
    let cancelled = false
    window.api.songInfoGet(detail.path)
      .then(meta => {
        if (!cancelled) setSongMeta(meta)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [detail])

  const duration = track.durationSec ?? detail?.durationSec ?? null
  const path = detail?.path ?? null
  const size = detail?.size ?? null
  const modifiedAt = detail?.modifiedAt ?? null
  const remoteId = detail?.remoteId ?? null

  // 订阅歌曲信息检索事件流（增量文本 / 工具状态 / 完成 / 出错）
  useEffect(() => {
    const unsubscribe = window.api.onSongInfoEvent(event => {
      if (!lookupIdRef.current || event.requestId !== lookupIdRef.current) return
      if (event.type === 'delta') {
        setStreamText(previous => previous + event.text)
      } else if (event.type === 'tools') {
        setToolStatus(event.status)
      } else if (event.type === 'done') {
        lookupIdRef.current = null
        setLookupId(null)
        setStreamText('')
        setToolStatus(null)
        setSongMeta(event.meta)
      } else {
        lookupIdRef.current = null
        setLookupId(null)
        setStreamText('')
        setToolStatus(null)
        setLookupError(event.message)
      }
    })
    return unsubscribe
  }, [])

  async function downloadToLocal(): Promise<void> {
    if (downloadBusy) return
    setDownloadBusy(true)
    setDownloadStatus('')
    try {
      const result = await window.api.trackDownload(track.id)
      setDownloadStatus(`已下载到 ${result.path}`)
    } catch (error) {
      setDownloadStatus(`下载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDownloadBusy(false)
    }
  }

  async function startLookup(): Promise<void> {
    if (lookupIdRef.current) return
    setLookupError(null)
    setStreamText('')
    setToolStatus(null)
    try {
      const started = await window.api.songInfoLookup(track.id)
      lookupIdRef.current = started.requestId
      setLookupId(started.requestId)
    } catch (error) {
      setLookupError(error instanceof Error ? error.message : String(error))
    }
  }

  function renderLyrics(meta: SongInfoMeta) {
    if (meta.lyricsBilingual.length > 0) {
      return (
        <div className="song-info-lyrics bilingual">
          {meta.lyricsBilingual.map((line, index) => (
            <p key={index} className="song-info-lyric-line">
              <span className="original">{line.original}</span>
              {line.translated && <span className="translated">{line.translated}</span>}
            </p>
          ))}
        </div>
      )
    }
    if (typeof meta.lyrics === 'string' && meta.lyrics) {
      return <pre className="song-info-lyrics">{meta.lyrics}</pre>
    }
    return null
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
        <div className="detail-cover" aria-hidden="true">♪</div>
        <div className="detail-info">
          <h2>{track.title}</h2>
          <p>{track.artist ?? trackSourceLabel(track.sourceId)}</p>
          <div className="detail-actions">
            <button className="primary-button" onClick={onPlay}>播放</button>
            <button
              type="button"
              className="quiet-button"
              onClick={() => void downloadToLocal()}
              disabled={downloadBusy}
            >
              {downloadBusy ? '下载中…' : '下载'}
            </button>
          </div>
          {downloadStatus && <p className="detail-download-status">{downloadStatus}</p>}
        </div>
      </div>

      <dl className="detail-meta">
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
      </dl>

      <section className="song-info">
        <div className="song-info-header">
          <h3>歌曲信息</h3>
          <button
            type="button"
            className="quiet-button"
            onClick={() => void startLookup()}
            disabled={lookupId !== null}
          >
            {lookupId ? '检索中…' : songMeta?.found ? '重新检索' : 'AI 联网检索'}
          </button>
        </div>
        {lookupError && <p className="song-info-error">{lookupError}</p>}
        {lookupId ? (
          <div className="song-info-streaming">
            {toolStatus && toolStatus.toolCallCount > 0 && (
              <p className="song-info-tools">
                已调用工具 {toolStatus.toolCallCount} 次{toolStatus.currentTool ? ` · 正在使用 ${toolStatus.currentTool}` : ''}
              </p>
            )}
            <pre className="song-info-raw">{streamText || '正在联网检索，首次响应可能需要十几秒…'}</pre>
          </div>
        ) : songMeta && !songMeta.found ? (
          <p className="song-info-empty">上次检索未找到：{songMeta.reason || '无原因记录'}</p>
        ) : songMeta ? (
          <>
            {songMeta.intro && <p className="song-info-intro">{songMeta.intro}</p>}
            {renderLyrics(songMeta)}
            <p className="song-info-footer">via {songMeta.model} · {new Date(songMeta.updatedAt).toLocaleString()}</p>
          </>
        ) : (
          <p className="song-info-empty">暂无歌曲信息。点击「AI 联网检索」获取歌曲介绍与歌词。</p>
        )}
      </section>
    </div>
  )
}
