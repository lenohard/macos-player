import { useState } from 'react'
import ActionNotice, { problemHint } from './ActionNotice'

type BusyKind = 'export' | 'import' | null

export default function BackupSettings() {
  const [busy, setBusy] = useState<BusyKind>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (kind: Exclude<BusyKind, null>): Promise<void> => {
    setBusy(kind)
    setMessage(null)
    setError(null)
    try {
      if (kind === 'export') {
        const path = await window.api.libraryExport()
        if (path) setMessage(`已导出到 ${path}`)
      } else {
        const result = await window.api.libraryImport()
        if (result) {
          setMessage(
            `导入完成：新建歌单 ${result.playlistsCreated} 个、合并到已有歌单 ${result.playlistsMatched} 个；` +
            `新增曲目 ${result.tracksAdded} 首、未找到 ${result.tracksMissing} 首；` +
            `收藏新增 ${result.favoritesAdded} 首、已存在 ${result.favoritesExisting} 首。`
          )
        }
      }
    } catch (err) {
      setError(problemHint(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="settings-sections">
      <section className="settings-section" aria-labelledby="backup-settings-title">
        <div className="settings-section-header">
          <div>
            <h2 id="backup-settings-title">备份与恢复</h2>
            <p>导出/导入歌单与收藏（JSON 文件）。换机时先登录网盘并导入音乐库，再导入备份即可恢复。</p>
          </div>
        </div>
        <div className="settings-actions">
          <button className="primary-button" onClick={() => void run('export')} disabled={busy !== null}>
            {busy === 'export' ? '正在导出…' : '导出备份…'}
          </button>
          <button className="quiet-button" onClick={() => void run('import')} disabled={busy !== null}>
            {busy === 'import' ? '正在导入…' : '导入备份…'}
          </button>
        </div>
        {message && <ActionNotice tone="success" title="备份操作完成" message={message} onDismiss={() => setMessage(null)} />}
        {error && <ActionNotice title="备份操作失败" message={error} onDismiss={() => setError(null)} />}
      </section>
    </div>
  )
}
