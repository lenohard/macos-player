import type { UpdateSnapshot } from '@shared/ipc'

function statusLabel(snapshot: UpdateSnapshot): string {
  switch (snapshot.status) {
    case 'idle':
      return snapshot.enabled ? '可检查更新' : '开发模式不检查更新'
    case 'checking':
      return '正在检查…'
    case 'available':
      return `发现新版本 ${snapshot.info?.version ?? ''}`
    case 'not-available':
      return '已是最新版本'
    case 'downloading':
      return `正在下载… ${Math.round(snapshot.progress ?? 0)}%`
    case 'downloaded':
      return `已下载 ${snapshot.info?.version ?? ''}，可重启安装`
    case 'error':
      return snapshot.error ?? '更新失败'
    default:
      return ''
  }
}

interface AboutPanelProps {
  snapshot: UpdateSnapshot
  busy: boolean
  onCheck(): void
  onDownload(): void
  onInstall(): void
}

export default function AboutPanel({ snapshot, busy, onCheck, onDownload, onInstall }: AboutPanelProps) {
  return (
    <div className="library-panel about-panel">
      <p className="panel-title">corner · v{snapshot.appVersion}</p>
      <p className="about-lead">本地与网盘音乐播放器。更新从 GitHub Releases 拉取（需已安装正式版）。</p>

      <div className="about-update">
        <p className="about-status" role="status">
          {statusLabel(snapshot)}
        </p>
        {snapshot.status === 'downloading' && snapshot.progress != null && (
          <div className="about-progress" aria-hidden="true">
            <div className="about-progress-fill" style={{ width: `${Math.min(100, snapshot.progress)}%` }} />
          </div>
        )}
        {snapshot.info?.releaseNotes && (
          <pre className="about-release-notes">{snapshot.info.releaseNotes}</pre>
        )}
        <div className="about-actions">
          <button className="quiet-button" onClick={onCheck} disabled={busy || !snapshot.enabled}>
            检查更新
          </button>
          {snapshot.status === 'available' && (
            <button className="primary-button" onClick={onDownload} disabled={busy}>
              下载更新
            </button>
          )}
          {snapshot.status === 'downloaded' && (
            <button className="primary-button" onClick={onInstall} disabled={busy}>
              重启并安装
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
