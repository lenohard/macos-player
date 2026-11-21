import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiConfig, AiModelInfo } from '@shared/ipc'
import { DEFAULT_AI_MODEL, DEFAULT_PI_WEB_URL, normalizePiWebUrl } from '@shared/ai-defaults'
import ActionNotice from './ActionNotice'

function fullId(model: AiModelInfo): string {
  const provider = model.provider ?? 'opencode-go'
  return model.id.startsWith(`${provider}:`) ? model.id : `${provider}:${model.id}`
}

function connectionHint(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (text.includes('PI_WEB_INVALID_URL')) return '请输入有效的 HTTP 或 HTTPS 地址，不要包含密码、参数或片段。'
  if (text.includes('PI_WEB_TIMEOUT')) return '连接超时。检查网络或 Tailscale 连接，再试一次。'
  if (text.includes('PI_WEB_DENIED')) return '服务拒绝访问。请检查 pi-web 的访问权限。'
  if (text.includes('PI_WEB_BAD_RESPONSE')) return '此地址没有返回模型目录。请检查地址是否指向 pi-web。'
  if (text.includes('PI_WEB_SERVICE_ERROR')) return 'pi-web 暂时无法提供模型目录，请稍后重试。'
  return '检查 pi-web 是否在运行；如果使用远程地址，请确认两台设备都已连接 Tailscale。'
}

interface ConnectionState {
  url: string
  models?: AiModelInfo[]
  pending?: 'test' | 'refresh'
  error?: string
  tested?: boolean
}

export default function AiSettings() {
  const [saved, setSaved] = useState<AiConfig | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [piWebUrl, setPiWebUrl] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [songInfoPrompt, setSongInfoPrompt] = useState('')
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | 'error' | null>(null)
  const [connection, setConnection] = useState<ConnectionState | null>(null)
  const [connectionDismissed, setConnectionDismissed] = useState(false)
  const [search, setSearch] = useState('')
  const fetchSequence = useRef(0)
  const lastAttemptedUrl = useRef<string | null>(null)
  const saveSequence = useRef(0)
  const pendingDraft = useRef<AiConfig | null>(null)
  const loadedRequest = useRef(0)

  const load = useCallback(() => {
    const request = ++loadedRequest.current
    setLoadError(false)
    void window.api.aiGetConfig().then(config => {
      if (request !== loadedRequest.current) return
      setSaved(config)
      setPiWebUrl(config.piWebUrl)
      setDefaultModel(config.defaultModel)
      setSongInfoPrompt(config.songInfoPrompt ?? '')
    }).catch(() => {
      if (request === loadedRequest.current) setLoadError(true)
    })
  }, [])

  useEffect(() => {
    load()
    return () => { loadedRequest.current++; fetchSequence.current++ }
  }, [load])

  const address = useMemo(() => {
    try { return normalizePiWebUrl(piWebUrl) } catch { return null }
  }, [piWebUrl])
  const config = useMemo<AiConfig | null>(() => address ? {
    piWebUrl: address,
    defaultModel: defaultModel.trim() || DEFAULT_AI_MODEL,
    songInfoPrompt: songInfoPrompt.trim()
  } : null, [address, defaultModel, songInfoPrompt])
  const dirty = !!saved && !!config && (
    config.piWebUrl !== saved.piWebUrl || config.defaultModel !== saved.defaultModel ||
    config.songInfoPrompt !== (saved.songInfoPrompt ?? '')
  )

  const save = useCallback((draft: AiConfig) => {
    pendingDraft.current = null
    const request = ++saveSequence.current
    setSaveStatus('saving')
    void window.api.aiSaveConfig(draft).then(updated => {
      if (request !== saveSequence.current) return
      setSaved(updated)
      setSaveStatus('saved')
    }, () => { if (request === saveSequence.current) setSaveStatus('error') })
  }, [])

  useEffect(() => () => {
    // Leaving the page should not discard a valid edit made in the last 600ms.
    if (pendingDraft.current) void window.api.aiSaveConfig(pendingDraft.current).catch(() => {})
    pendingDraft.current = null
    saveSequence.current++
  }, [])

  useEffect(() => {
    if (!dirty || !config) { pendingDraft.current = null; return }
    pendingDraft.current = config
    const timer = window.setTimeout(() => save(config), 600)
    return () => window.clearTimeout(timer)
  }, [config, dirty, save])

  useEffect(() => {
    if (saveStatus !== 'saved') return
    const timer = window.setTimeout(() => setSaveStatus(null), 1800)
    return () => window.clearTimeout(timer)
  }, [saveStatus])

  const fetchModels = useCallback(async (url: string, intent: 'test' | 'refresh', background = false) => {
    const request = ++fetchSequence.current
    lastAttemptedUrl.current = url
    if (!background) {
      setConnectionDismissed(false)
      setConnection(previous => ({ url, models: previous?.url === url ? previous.models : undefined, pending: intent }))
    }
    try {
      const models = await window.api.aiFetchModels(url)
      if (request === fetchSequence.current) setConnection({ url, models, tested: intent === 'test' })
    } catch (error) {
      if (request !== fetchSequence.current || background) return
      setConnection(previous => ({ url, models: previous?.models, error: connectionHint(error) }))
    }
  }, [])

  const hasConfig = !!saved
  useEffect(() => {
    if (!hasConfig || !address || lastAttemptedUrl.current === address) return
    const timer = window.setTimeout(() => {
      if (lastAttemptedUrl.current !== address) void fetchModels(address, 'refresh')
    }, 450)
    return () => window.clearTimeout(timer)
  }, [address, hasConfig, fetchModels])

  const state = connection?.url === address ? connection : null
  useEffect(() => {
    if (!state?.error || !address) return
    const retry = () => {
      if (lastAttemptedUrl.current === address) void fetchModels(address, 'refresh', true)
    }
    const timer = window.setInterval(retry, 30_000)
    window.addEventListener('online', retry)
    return () => { window.clearInterval(timer); window.removeEventListener('online', retry) }
  }, [state, address, fetchModels])

  const displayed = useMemo(() => {
    const query = search.trim().toLowerCase()
    return (state?.models ?? []).filter(model => !query || `${fullId(model)} ${model.name ?? ''}`.toLowerCase().includes(query))
  }, [state?.models, search])

  if (!saved) return loadError ? (
    <ActionNotice title="未能读取大模型设置" action={{ label: '重试', run: load }} />
  ) : <p className="ai-model-empty" role="status">正在读取大模型设置…</p>

  const retry = () => { if (address) void fetchModels(address, 'refresh') }

  return (
    <div className="ai-settings">
      <div className="ai-settings-heading">
        <p className="panel-title">pi-web · 歌曲介绍与歌词</p>
        <span className="ai-settings-save-status" role="status">
          {saveStatus === 'saving' ? '保存中…' : dirty ? '修改待保存' : saveStatus === 'saved' ? '已保存 ✓' : '自动保存'}
        </span>
      </div>
      {saveStatus === 'error' && (
        <ActionNotice title="未能保存设置" message="已保留输入内容，请重试。"
          onDismiss={() => setSaveStatus(null)} action={config ? { label: '重试', run: () => save(config) } : undefined} />
      )}

      <section className="ai-card" aria-labelledby="ai-connection-title">
        <div className="ai-card-heading">
          <h2 className="ai-card-title" id="ai-connection-title">服务连接</h2>
          <span className={`settings-status${state?.models && !state.error ? ' connected' : ''}`}>
            {state?.pending ? '连接中' : state?.error ? '暂不可用' : state?.models ? '可用' : '未检查'}
          </span>
        </div>
        <div className="ai-field">
          <label className="ai-field-label" htmlFor="pi-web-url">pi-web 地址</label>
          <div className="ai-input-row">
            <input id="pi-web-url" type="text" value={piWebUrl} placeholder={DEFAULT_PI_WEB_URL}
              onChange={event => setPiWebUrl(event.target.value)} aria-invalid={!address}
              aria-describedby="ai-url-note" spellCheck={false} />
            {piWebUrl !== DEFAULT_PI_WEB_URL && (
              <button type="button" className="quiet-button" onClick={() => setPiWebUrl(DEFAULT_PI_WEB_URL)}>恢复默认</button>
            )}
          </div>
          <span className="ai-field-note" id="ai-url-note">
            {address ? '连接本机或 Tailscale 私网中的 pi-web 服务。' : '请输入有效的 HTTP 或 HTTPS 地址。'}
          </span>
        </div>
        <div className="ai-test-row">
          <button type="button" className="quiet-button" onClick={() => address && void fetchModels(address, 'test')}
            disabled={!address || !!state?.pending}>
            {state?.pending === 'test' ? '测试中…' : '测试连接'}
          </button>
          {state?.tested && <span role="status" className="ai-field-note">连接成功 · {state.models?.length ?? 0} 个可用模型</span>}
        </div>
        {state?.error && !connectionDismissed && (
          <ActionNotice title="无法连接模型服务" message={state.error}
            onDismiss={() => setConnectionDismissed(true)}
            action={{ label: '重试', run: retry }} />
        )}
      </section>

      <section className="ai-card" aria-labelledby="ai-model-title">
        <h2 className="ai-card-title" id="ai-model-title">默认模型</h2>
        <div className="ai-field">
          <label className="ai-field-label" htmlFor="ai-model-id">模型 ID</label>
          <input id="ai-model-id" type="text" value={defaultModel} placeholder={DEFAULT_AI_MODEL}
            onChange={event => setDefaultModel(event.target.value)} spellCheck={false} />
          <span className="ai-field-note">从下方选择，或输入「服务商:模型 ID」。仅影响新发起的检索。</span>
          {state?.models?.length && !state.models.some(item => fullId(item) === config?.defaultModel) ? (
            <span className="ai-field-note ai-warn">当前模型不在服务返回的列表里。若检索失败，请从下方选一个可用模型。</span>
          ) : null}
        </div>
        <div className="ai-browser-controls">
          <input type="text" aria-label="筛选模型" value={search} placeholder="筛选可用模型…"
            onChange={event => setSearch(event.target.value)} spellCheck={false} />
          <button type="button" className="quiet-button" onClick={retry} disabled={!address || !!state?.pending}>
            {state?.pending === 'refresh' ? '加载中…' : '刷新'}
          </button>
          {state?.models && <span className="ai-field-note ai-model-count">{displayed.length} / {state.models.length} 个</span>}
        </div>
        {displayed.length ? (
          <div className="ai-model-list" role="group" aria-label="可用模型">
            {displayed.map(model => {
              const id = fullId(model)
              const selected = id === config?.defaultModel
              return (
                <button key={id} type="button" className={`ai-model-row${selected ? ' active' : ''}`}
                  aria-pressed={selected} onClick={() => setDefaultModel(id)} title={id}>
                  <span className="ai-model-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                  <span className="ai-model-id">{model.id}</span>
                  <span className="ai-model-provider">{model.provider ?? 'opencode-go'}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <p className="ai-model-empty" role="status">
            {state?.pending ? '正在获取模型列表…' : state?.models?.length ? '没有匹配的模型。' :
              state?.models ? 'pi-web 尚无可用模型。' : '暂无模型目录。可以手动填写模型 ID，或刷新列表。'}
          </p>
        )}
      </section>

      <details className="ai-card ai-advanced">
        <summary>高级 · 检索提示词</summary>
        <div className="ai-field">
          <label className="ai-field-label" htmlFor="ai-prompt">自定义歌曲检索提示词</label>
          <textarea id="ai-prompt" className="ai-prompt-input" value={songInfoPrompt}
            placeholder="留空使用内置提示词" onChange={event => setSongInfoPrompt(event.target.value)} rows={5} spellCheck={false} />
          <span className="ai-field-note">{'使用 {query} 插入曲目信息。自定义提示词须保留 JSON 字段：found、intro、lyrics、lyricsBilingual、reason。'}</span>
          {songInfoPrompt && <button type="button" className="quiet-button align-start" onClick={() => setSongInfoPrompt('')}>恢复默认</button>}
        </div>
      </details>
    </div>
  )
}
