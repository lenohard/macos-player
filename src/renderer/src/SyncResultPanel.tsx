import type { BaiduImportResult, SyncTrackDetail } from '@shared/ipc'

const VISIBLE_LIMIT = 50

interface Section {
  key: 'added' | 'updated' | 'removed'
  label: string
  count: number
  tracks: SyncTrackDetail[]
}

export default function SyncResultPanel({
  result,
  onClose
}: {
  result: BaiduImportResult
  onClose: () => void
}): JSX.Element {
  const sections: Section[] = [
    { key: 'added', label: '新增', count: result.added, tracks: result.addedTracks },
    { key: 'updated', label: '更新', count: result.updated, tracks: result.updatedTracks },
    { key: 'removed', label: '移除', count: result.removed, tracks: result.removedTracks }
  ]

  const hasChanges = sections.some(section => section.count > 0)

  return (
    <div className="sync-result-panel" role="region" aria-label="同步结果">
      <div className="sync-result-header">
        <p className="panel-title">
          同步结果 · 新增 {result.added} · 更新 {result.updated} · 移除 {result.removed}
        </p>
        <button className="quiet-button" onClick={onClose}>关闭</button>
      </div>
      {!hasChanges && <p className="sync-result-empty">未发现变化</p>}
      <div className="sync-result-sections">
        {sections.map(section => section.count > 0 && (
          <div key={section.key} className={`sync-result-section sync-result-${section.key}`}>
            <p className="sync-result-label">{section.label}（{section.count}）</p>
            <ul className="sync-result-list">
              {section.tracks.slice(0, VISIBLE_LIMIT).map(track => (
                <li key={track.id} className="sync-result-row">
                  <span className="track-name" title={track.title}>{track.title}</span>
                  <span className="track-artist">{track.artist ?? '未知艺术家'}</span>
                  <span className="track-source" title={track.path}>{track.path}</span>
                  {section.key === 'updated' && track.previousPath && (
                    <span className="sync-result-previous" title={track.previousPath}>← {track.previousPath}</span>
                  )}
                </li>
              ))}
            </ul>
            {section.tracks.length > VISIBLE_LIMIT && (
              <p className="sync-result-more">
                共 {section.tracks.length} 首，仅显示前 {VISIBLE_LIMIT} 首
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
