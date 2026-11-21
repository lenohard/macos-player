import { useEffect, useRef, type ReactNode } from 'react'

export default function AppDialog({ title, children, onClose, footer, compact = false }: {
  title: string
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
  compact?: boolean
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => { dialog?.close() }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className={`app-dialog${compact ? ' app-dialog-compact' : ''}`}
      aria-label={title}
      onCancel={event => { event.preventDefault(); onClose() }}
    >
      <header className="app-dialog-header">
        <h2>{title}</h2>
        <button type="button" className="notice-close" aria-label="关闭窗口" onClick={onClose}>×</button>
      </header>
      <div className="app-dialog-body">{children}</div>
      {footer && <div className="app-dialog-footer">{footer}</div>}
    </dialog>
  )
}
