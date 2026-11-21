import { useState } from 'react'
import ActionNotice from './ActionNotice'
import AppDialog from './AppDialog'
import type { BaiduAuthStatus, UpdateSnapshot, WebDAVStatus } from '@shared/ipc'
import AboutPanel from './AboutPanel'
import AiSettings from './AiSettings'
import BackupSettings from './BackupSettings'

type SettingsSection = 'connections' | 'backup' | 'ai' | 'about'

interface Props {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  baiduStatus: BaiduAuthStatus | null
  baiduBusy: boolean
  onBaiduLogin: () => void
  onBaiduLogout: () => void
  webdavStatus: WebDAVStatus | null
  webdavBusy: boolean
  webdavForm: { url: string; username: string; password: string }
  onWebdavFormChange: (form: { url: string; username: string; password: string }) => void
  onWebdavSave: () => Promise<boolean>
  onWebdavDisconnect: () => void
  updateSnapshot: UpdateSnapshot
  updateBusy: boolean
  onUpdateCheck: () => void
  onUpdateDownload: () => void
  onUpdateInstall: () => void
}

function StatusBadge({ connected, pending = false }: { connected: boolean; pending?: boolean }) {
  return (
    <span className={`settings-status ${connected ? 'connected' : ''}`}>
      {pending ? '检查中' : connected ? '已连接' : '未连接'}
    </span>
  )
}

export default function SettingsPanel(props: Props) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [webdavFailed, setWebdavFailed] = useState(false)
  const [webdavErrorDismissed, setWebdavErrorDismissed] = useState(false)
  const submitWebdav = (event: React.FormEvent): void => {
    event.preventDefault()
    setWebdavErrorDismissed(false)
    setWebdavFailed(false)
    void props.onWebdavSave().then(connected => setWebdavFailed(!connected))
  }

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        <button type="button" aria-current={props.section === 'connections' ? 'page' : undefined}
          className={props.section === 'connections' ? 'active' : ''}
          onClick={() => props.onSectionChange('connections')}
        >
          连接
        </button>
        <button type="button" aria-current={props.section === 'backup' ? 'page' : undefined}
          className={props.section === 'backup' ? 'active' : ''}
          onClick={() => props.onSectionChange('backup')}
        >
          备份
        </button>
        <button type="button" aria-current={props.section === 'ai' ? 'page' : undefined}
          className={props.section === 'ai' ? 'active' : ''}
          onClick={() => props.onSectionChange('ai')}
        >
          大模型
        </button>
        <button type="button" aria-current={props.section === 'about' ? 'page' : undefined}
          className={props.section === 'about' ? 'active' : ''}
          onClick={() => props.onSectionChange('about')}
        >
          关于
        </button>
      </nav>

      <div className="settings-content">
        {props.section === 'connections' ? (
          <div className="settings-sections">
            <>
            <section className="settings-section" aria-labelledby="baidu-settings-title">
              <div className="settings-section-header">
                <div>
                  <h2 id="baidu-settings-title">百度网盘</h2>
                  <p>登录后可浏览并导入网盘音乐。</p>
                </div>
                <StatusBadge connected={props.baiduStatus?.connected ?? false} pending={!props.baiduStatus} />
              </div>
              <div className="settings-actions">
                {props.baiduStatus?.connected ? (
                  <button className="quiet-button" onClick={props.onBaiduLogout} disabled={props.baiduBusy}>
                    {props.baiduBusy ? '正在退出…' : '退出登录'}
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    onClick={props.onBaiduLogin}
                    disabled={props.baiduBusy || props.baiduStatus?.configured === false}
                  >
                    {props.baiduBusy ? '正在登录…' : '登录百度网盘'}
                  </button>
                )}
                {props.baiduStatus?.configured === false && <p className="settings-hint">需要先配置百度 OAuth 凭据。</p>}
              </div>
            </section>

            <section className="settings-section" aria-labelledby="webdav-settings-title">
              <div className="settings-section-header">
                <div>
                  <h2 id="webdav-settings-title">WebDAV</h2>
                  <p>保存后会立即测试连接；编辑时密码留空将保留原密码。</p>
                </div>
                <StatusBadge connected={props.webdavStatus?.connected ?? false} pending={!props.webdavStatus} />
              </div>
              <form className="settings-form" onSubmit={submitWebdav}>
                <label>
                  服务器地址
                  <input
                    type="url"
                    value={props.webdavForm.url}
                    onChange={event => props.onWebdavFormChange({ ...props.webdavForm, url: event.target.value })}
                    placeholder="https://dav.example.com"
                    autoComplete="url"
                    required
                  />
                </label>
                <div className="settings-form-row">
                  <label>
                    用户名
                    <input
                      type="text"
                      value={props.webdavForm.username}
                      onChange={event => props.onWebdavFormChange({ ...props.webdavForm, username: event.target.value })}
                      autoComplete="username"
                    />
                  </label>
                  <label>
                    密码
                    <input
                      type="password"
                      value={props.webdavForm.password}
                      onChange={event => props.onWebdavFormChange({ ...props.webdavForm, password: event.target.value })}
                      placeholder={props.webdavStatus?.configured ? '留空以保留当前密码' : ''}
                      autoComplete="current-password"
                    />
                  </label>
                </div>
                <div className="settings-actions">
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={props.webdavBusy || !props.webdavForm.url.trim()}
                  >
                    {props.webdavBusy ? '正在连接…' : props.webdavStatus?.configured ? '保存并重新连接' : '保存并连接'}
                  </button>
                  {props.webdavStatus?.configured && (
                    <button className="quiet-button danger" type="button" onClick={() => setConfirmDisconnect(true)} disabled={props.webdavBusy}>
                      断开并清除配置
                    </button>
                  )}
                </div>
                {webdavFailed && !webdavErrorDismissed && (
                  <ActionNotice title="无法验证 WebDAV 连接" message="请核对服务器地址、登录凭据和网络，然后重新连接。"
                    onDismiss={() => setWebdavErrorDismissed(true)} />
                )}
              </form>
            </section>
            </>
          </div>
        ) : props.section === 'backup' ? (
          <BackupSettings />
        ) : props.section === 'ai' ? (
          <AiSettings />
        ) : (
          <AboutPanel
            snapshot={props.updateSnapshot}
            busy={props.updateBusy}
            onCheck={props.onUpdateCheck}
            onDownload={props.onUpdateDownload}
            onInstall={props.onUpdateInstall}
          />
        )}
      </div>
      {confirmDisconnect && (
        <AppDialog compact title="断开 WebDAV？" onClose={() => setConfirmDisconnect(false)} footer={
          <>
            <button type="button" className="quiet-button" autoFocus onClick={() => setConfirmDisconnect(false)}>保留连接</button>
            <button type="button" className="quiet-button danger" onClick={() => {
              setConfirmDisconnect(false)
              setWebdavFailed(false)
              props.onWebdavDisconnect()
            }}>断开连接</button>
          </>
        }>
          <p>本机保存的连接配置将被清除，网盘上的文件不会被删除。</p>
        </AppDialog>
      )}
    </div>
  )
}
