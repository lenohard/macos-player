import type { FormEvent } from 'react'
import type { BaiduAuthStatus, UpdateSnapshot, WebDAVStatus } from '@shared/ipc'
import AboutPanel from './AboutPanel'
import AiSettings from './AiSettings'

type SettingsSection = 'connections' | 'ai' | 'about'

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
  onWebdavSave: () => void
  onWebdavDisconnect: () => void
  updateSnapshot: UpdateSnapshot
  updateBusy: boolean
  cliBusy: boolean
  cliInstalled: boolean
  cliError: string | null
  onCliInstall: () => void
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
  const submitWebdav = (event: FormEvent): void => {
    event.preventDefault()
    props.onWebdavSave()
  }

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        <button
          className={props.section === 'connections' ? 'active' : ''}
          onClick={() => props.onSectionChange('connections')}
        >
          连接
        </button>
        <button
          className={props.section === 'ai' ? 'active' : ''}
          onClick={() => props.onSectionChange('ai')}
        >
          大模型
        </button>
        <button
          className={props.section === 'about' ? 'active' : ''}
          onClick={() => props.onSectionChange('about')}
        >
          关于
        </button>
      </nav>

      <div className="settings-content">
        {props.section === 'connections' ? (
          <div className="settings-sections">
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
                    <button className="quiet-button danger" type="button" onClick={props.onWebdavDisconnect} disabled={props.webdavBusy}>
                      断开并清除配置
                    </button>
                  )}
                </div>
              </form>
            </section>
          </div>
        ) : props.section === 'ai' ? (
          <AiSettings />
        ) : (
          <AboutPanel
            snapshot={props.updateSnapshot}
            busy={props.updateBusy}
            cliBusy={props.cliBusy}
            cliInstalled={props.cliInstalled}
            cliError={props.cliError}
            onCliInstall={props.onCliInstall}
            onCheck={props.onUpdateCheck}
            onDownload={props.onUpdateDownload}
            onInstall={props.onUpdateInstall}
          />
        )}
      </div>
    </div>
  )
}
