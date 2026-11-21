import { useEffect, useState } from 'react'
import type { IPCApi, Track } from '@shared/ipc'
import ActionNotice from './ActionNotice'
import AppDialog from './AppDialog'
import { trackSourceLabel } from './sourceLabels'

type AiTrackPickerApi = Pick<IPCApi, 'listTracksPage' | 'songInfoLookup'>

export default function AiTrackPicker({ onClose, onStarted, runningIds, api = window.api }: {
  onClose(): void
  onStarted(): void
  runningIds: ReadonlySet<string>
  api?: AiTrackPickerApi
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<{ query: string; tracks: Track[]; total: number } | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const [error, setError] = useState<'list' | 'lookup' | null>(null)
  const [reload, setReload] = useState(0)
  const search = query.trim()

  useEffect(() => {
    if (!search) return
    let active = true
    const timer = window.setTimeout(() => {
      void api.listTracksPage('all', 0, 20, search).then(result => {
        if (active) setPage({ query: search, tracks: result.tracks, total: result.total })
      }, () => { if (active) setError('list') })
    }, 220)
    return () => { active = false; window.clearTimeout(timer) }
  }, [api, search, reload])

  async function start(track: Track) {
    if (starting || runningIds.has(track.id)) return
    setStarting(track.id)
    setError(null)
    try {
      await api.songInfoLookup(track.id)
      onStarted()
    } catch {
      setError('lookup')
    } finally {
      setStarting(null)
    }
  }

  const currentPage = page?.query === search ? page : null
  return (
    <AppDialog title="检索曲目" onClose={onClose}>
      <div className="ai-field ai-track-picker-field">
        <label className="ai-field-label" htmlFor="ai-track-query">在音乐库中找一首歌</label>
        <input id="ai-track-query" className="app-text-input" type="search" placeholder="输入歌名或歌手"
          value={query} onChange={event => { setQuery(event.target.value); setError(null) }} autoFocus />
        <span className="ai-field-note">AI 将联网查找歌曲介绍与歌词。关掉这个窗口不会中断检索。</span>
      </div>
      {error && (
        <ActionNotice title={error === 'list' ? '未能载入曲目' : '未能启动检索'}
          message={error === 'lookup' ? '请确认曲目仍在音乐库中，再试一次。' : undefined}
          onDismiss={() => setError(null)} action={error === 'list' ? {
            label: '重试', run: () => { setError(null); setReload(value => value + 1) }
          } : undefined} />
      )}
      {!search ? (
        <p className="ai-track-picker-empty">只搜索本地和已导入的网盘音乐。</p>
      ) : !currentPage ? (
        error !== 'list' && <p className="ai-track-picker-empty" role="status">正在搜索音乐库…</p>
      ) : currentPage.tracks.length === 0 ? (
        <p className="ai-track-picker-empty" role="status">没有匹配的曲目，试试更短的关键词。</p>
      ) : (
        <>
          <ul className="ai-track-picker-list">
            {currentPage.tracks.map(track => (
              <li key={track.id}>
                <div>
                  <strong title={track.title}>{track.title}</strong>
                  <span>{[track.artist, trackSourceLabel(track.sourceId)].filter(Boolean).join(' · ')}</span>
                </div>
                <button type="button" className="quiet-button" onClick={() => void start(track)}
                  aria-label={`检索 ${track.title}`} disabled={!!starting || runningIds.has(track.id)}>
                  {runningIds.has(track.id) ? '进行中' : starting === track.id ? '正在启动…' : '开始检索'}
                </button>
              </li>
            ))}
          </ul>
          {currentPage.total > 20 && <p className="ai-field-note">显示前 20 首，共 {currentPage.total} 首。可缩小搜索范围。</p>}
        </>
      )}
    </AppDialog>
  )
}
