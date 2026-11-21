import { useEffect } from 'react'

interface Props {
  title: string
  message?: string
  tone?: 'error' | 'success'
  onDismiss?: () => void
  action?: { label: string; run: () => void }
}

export function problemHint(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/此操作请切换到本地模式或在服务器上管理/.test(text)) return '此操作请切换到本地模式或在服务器上管理。'
  if (/ERR_(?:PROXY|TUNNEL)/i.test(text)) return '请检查系统代理是否可用，再试一次。'
  if (/401|403|unauthorized|forbidden/i.test(text)) return '请检查登录状态或访问权限，再试一次。'
  if (/timeout|timed out|超时/i.test(text)) return '请求超时，请检查网络后重试。'
  if (/net::|network|fetch failed|ECONN|ENOTFOUND|网络/i.test(text)) return '请检查网络和服务连接后重试。'
  return '请稍后重试。'
}

export default function ActionNotice({ title, message, tone = 'error', onDismiss, action }: Props) {
  return (
    <div className={`action-notice action-notice-${tone}`}>
      <div className="action-notice-text" role={tone === 'error' ? 'alert' : 'status'}>
        <strong>{title}</strong>
        {message && <p>{message}</p>}
      </div>
      {action && <button type="button" className="quiet-button" onClick={action.run}>{action.label}</button>}
      {onDismiss && <button type="button" className="notice-close" aria-label="关闭提示" title="关闭提示" onClick={onDismiss}>×</button>}
    </div>
  )
}

export function ErrorToast({ notice, onDismiss }: { notice: { title: string; message?: string }; onDismiss: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 8000)
    return () => window.clearTimeout(timer)
  }, [notice, onDismiss])
  return <div className="notice-toast"><ActionNotice {...notice} onDismiss={onDismiss} /></div>
}
