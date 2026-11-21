import { useState } from 'react'
import type { UpdateSnapshot } from '@shared/ipc'
import ActionNotice, { problemHint } from './ActionNotice'

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
      return '更新不可用'
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

export default function AboutPanel({
  snapshot,
  busy,
  onCheck,
  onDownload,
  onInstall
}: AboutPanelProps) {
  const [dismissedUpdate, setDismissedUpdate] = useState<UpdateSnapshot | null>(null)
  const [cliBusy, setCliBusy] = useState(false)
  const [cliInstalled, setCliInstalled] = useState(false)
  const [cliNotice, setCliNotice] = useState<
    { tone: 'error' | 'success'; title: string; message?: string } | null
  >(null)

  async function installCli(): Promise<void> {
    setCliBusy(true)
    setCliNotice(null)
    try {
      const installedPath = await window.api.cliInstall()
      setCliInstalled(true)
      setCliNotice({
        tone: 'success',
        title: '命令行已安装',
        message: installedPath ? `已安装到 ${installedPath}` : '可在终端直接使用 corner 命令。'
      })
    } catch (installError) {
      setCliNotice({ tone: 'error', title: '命令行安装失败', message: problemHint(installError) })
    } finally {
      setCliBusy(false)
    }
  }

  return (
    <div className="library-panel about-panel">
      <div className="about-heading">
        <div>
          <p className="panel-title">corner · v{snapshot.appVersion}</p>
          <p className="about-lead">本地与网盘音乐播放器。</p>
        </div>
        <span className="about-version">macOS</span>
      </div>

      <section className="about-cli" aria-labelledby="about-cli-title">
        <div className="about-cli-header">
          <div>
            <h2 id="about-cli-title">命令行控制</h2>
            <p className="about-cli-desc">安装后可在终端直接使用 <code>corner</code> 搜索和控制播放。</p>
          </div>
          <span className={`about-cli-status ${cliInstalled ? 'installed' : ''}`}>
            {cliInstalled ? '已安装' : '未安装'}
          </span>
        </div>
        <div className="about-cli-path">
          <span>安装位置</span>
          <code>~/.local/bin/corner</code>
        </div>
        {cliNotice && (
          <ActionNotice
            tone={cliNotice.tone}
            title={cliNotice.title}
            message={cliNotice.message}
            onDismiss={() => setCliNotice(null)}
          />
        )}
        <div className="about-cli-actions">
          <button className="primary-button" onClick={() => void installCli()} disabled={cliBusy}>
            {cliBusy ? '安装中…' : cliInstalled ? '重新安装' : '安装命令行'}
          </button>
          <span className="about-cli-hint">无需 sudo，安装到当前用户目录</span>
        </div>
      </section>

      <div className="about-update">
        {snapshot.status === 'error' ? (
          dismissedUpdate !== snapshot && <ActionNotice title="暂时无法更新" message="请检查网络连接，再检查一次更新。"
            onDismiss={() => setDismissedUpdate(snapshot)} />
        ) : <p className="about-status" role="status">{statusLabel(snapshot)}</p>}
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
