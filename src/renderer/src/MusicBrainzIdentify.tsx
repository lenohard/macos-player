import { useState } from 'react'
import type {
  IPCApi,
  MusicBrainzCandidate,
  MusicBrainzLookupResult,
  TrackDetail
} from '@shared/ipc'
import ActionNotice, { problemHint } from './ActionNotice'
import AppDialog from './AppDialog'
import CoverImage from './CoverImage'

type IdentifyApi = Pick<IPCApi, 'musicBrainzLookup' | 'trackApplyIdentification'>

interface MusicBrainzIdentifyProps {
  detail: TrackDetail | null
  api?: IdentifyApi
  onApplied(detail: TrackDetail): void
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '未知'
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60)
  return `${minutes}:${remaining.toString().padStart(2, '0')}`
}

function durationHint(localSec: number | null, candidateSec: number | null): string {
  if (localSec === null || candidateSec === null) return '时长未知'
  const diff = Math.abs(localSec - candidateSec)
  if (diff <= 2) return '时长一致'
  return `时长差 ${diff} 秒`
}

/**
 * MusicBrainz 识别：候选检索不写库，用户点「使用此结果」后才写入
 * 标题/艺术家/专辑/封面/recording id 等字段。
 */
export default function MusicBrainzIdentify({ detail, api = window.api, onApplied }: MusicBrainzIdentifyProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MusicBrainzLookupResult | null>(null)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [applied, setApplied] = useState<string | null>(null)

  async function runLookup(): Promise<void> {
    if (!detail || loading) return
    setLoading(true)
    setError(null)
    setApplied(null)
    try {
      const found = await api.musicBrainzLookup(detail.id)
      setResult(found)
    } catch (problem) {
      setError(problemHint(problem))
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  async function applyCandidate(candidate: MusicBrainzCandidate): Promise<void> {
    if (!detail || applyingId) return
    setApplyingId(candidate.id)
    setError(null)
    try {
      const updated = await api.trackApplyIdentification(detail.id, {
        recordingId: candidate.id,
        releaseId: candidate.releaseId,
        artistId: candidate.artistId,
        album: candidate.album,
        coverUrl: candidate.coverUrl,
        score: candidate.score,
        title: candidate.title,
        artist: candidate.artist
      })
      onApplied(updated)
      setApplied(candidate.title)
      setOpen(false)
    } catch (problem) {
      setError(problemHint(problem))
    } finally {
      setApplyingId(null)
    }
  }

  function openDialog(): void {
    setOpen(true)
    if (!result && !loading) void runLookup()
  }

  if (!detail) return null

  return (
    <>
      <div className="mb-identify-header">
        <div>
          <h3>MusicBrainz 识别</h3>
          <p className="ai-field-note">
            {detail.identifiedAt
              ? `已识别于 ${new Date(detail.identifiedAt).toLocaleString()}`
              : '检索 MusicBrainz 数据库，保存专辑、封面与编号。'}
          </p>
        </div>
        <button type="button" className={detail.identifiedAt ? 'quiet-button' : 'primary-button'}
          onClick={openDialog} disabled={loading}>
          {detail.identifiedAt ? '重新识别' : '识别 / MusicBrainz'}
        </button>
      </div>
      {detail.identifiedAt && (
        <dl className="detail-meta">
          <div className="detail-meta-row">
            <dt>专辑</dt>
            <dd>{detail.album ?? '未知'}</dd>
          </div>
          <div className="detail-meta-row">
            <dt>MB 编号</dt>
            <dd className="detail-mono">{detail.mbRecordingId ?? '无'}</dd>
          </div>
          <div className="detail-meta-row">
            <dt>封面</dt>
            <dd>{detail.coverUrl ? '已保存' : '无'}</dd>
          </div>
        </dl>
      )}
      {applied && !open && (
        <ActionNotice title="已保存识别结果" message={applied} tone="success" onDismiss={() => setApplied(null)} />
      )}
      {open && (
        <AppDialog title="识别 / MusicBrainz" onClose={() => setOpen(false)} footer={
          <button type="button" className="quiet-button" onClick={() => void runLookup()} disabled={loading}>
            {loading ? '检索中…' : '重新检索'}
          </button>
        }>
          <div className="mb-identify">
            <p className="ai-field-note">
              分数只表示搜索相关度；确认候选后才会写入音乐库，不会改动音频文件标签。
            </p>
            {error && (
              <ActionNotice title="MusicBrainz 识别失败" message={error}
                action={{ label: '重试', run: () => void runLookup() }} onDismiss={() => setError(null)} />
            )}
            {loading && (
              <div className="mb-identify-loading" role="status">
                <span className="notice-spinner" aria-hidden="true" />
                <strong>正在检索 MusicBrainz 数据库…</strong>
              </div>
            )}
            {!loading && result?.candidates.length === 0 && (
              <p className="song-info-empty">没有找到候选结果，可以换关键词重试。</p>
            )}
            {!loading && result && result.candidates.length > 0 && (
              <ol className="mb-identify-list">
                {result.candidates.map(candidate => (
                  <li key={candidate.id}>
                    <CoverImage className="mb-candidate-cover" fallbackClassName="mb-candidate-cover-empty"
                      src={candidate.coverUrl} loading="lazy" />
                    <div className="mb-candidate-copy">
                      <strong>{candidate.title}</strong>
                      <span>{candidate.artist || '未知艺术家'}</span>
                      <span className="mb-candidate-meta">
                        {candidate.album || '未知专辑'} · {candidate.firstReleaseDate || '发行日期未知'}
                      </span>
                      <span className="mb-candidate-meta">
                        本地 {formatDuration(result.localDurationSec)} · 候选 {formatDuration(candidate.durationSec)}
                        {' · '}
                        {durationHint(result.localDurationSec, candidate.durationSec)}
                        {' · '}
                        相关度 {candidate.score}
                      </span>
                    </div>
                    <button type="button" className="quiet-button"
                      disabled={applyingId !== null}
                      onClick={() => void applyCandidate(candidate)}>
                      {applyingId === candidate.id ? '保存中…' : '使用此结果'}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </AppDialog>
      )}
    </>
  )
}
