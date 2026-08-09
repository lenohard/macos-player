import { useEffect, useState } from 'react'
import type { Track, TrackDetail as TrackDetailData } from '@shared/ipc'
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

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    window.api.trackGetDetail(track.id)
      .then(found => {
        if (!cancelled) setDetail(found)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [track.id])

  const duration = track.durationSec ?? detail?.durationSec ?? null
  const path = detail?.path ?? null
  const size = detail?.size ?? null
  const modifiedAt = detail?.modifiedAt ?? null
  const remoteId = detail?.remoteId ?? null

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
          <button className="primary-button" onClick={onPlay}>播放</button>
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
    </div>
  )
}
