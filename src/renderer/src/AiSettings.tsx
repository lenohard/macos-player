import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiConfig, AiModelInfo, AiProtocol, AiTestResult } from '@shared/ipc'

const PROTOCOLS: Array<{ value: AiProtocol; label: string; hint: string }> = [
  { value: 'chat', label: 'Chat Completions', hint: 'OpenAI 兼容 · /chat/completions' },
  { value: 'response', label: 'Responses', hint: 'OpenAI · /responses' },
  { value: 'message', label: 'Messages', hint: 'Anthropic · /messages' }
]

const DEFAULT_URLS: Record<AiProtocol, string> = {
  chat: 'https://opencode.ai/zen/go/v1',
  response: 'https://opencode.ai/zen/go/v1',
  message: 'https://opencode.ai/zen/go/v1'
}

const REASONING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '默认（自适应）' },
  { value: 'none', label: '禁用' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' }
]

const ENDPOINT_PATHS: Record<AiProtocol, string> = {
  chat: '/chat/completions',
  response: '/responses',
  message: '/messages'
}

function providerOf(model: AiModelInfo | string): string {
  if (typeof model !== 'string') {
    if (model.provider) return model.provider
    return providerOf(model.id)
  }
  const slash = model.indexOf('/')
  if (slash > 0) return model.slice(0, slash)
  const dash = model.indexOf('-')
  return dash > 0 ? model.slice(0, dash) : model
}

function fullRequestUrl(baseUrl: string, protocol: AiProtocol): string {
  const normalized = (baseUrl.trim() || DEFAULT_URLS[protocol]).replace(/\/$/, '')
  return `${normalized}${ENDPOINT_PATHS[protocol]}`
}

export default function AiSettings() {
  const [protocol, setProtocol] = useState<AiProtocol>('chat')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_URLS.chat)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')

  const [savedConfig, setSavedConfig] = useState<AiConfig | null>(null)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)

  const [models, setModels] = useState<AiModelInfo[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')

  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<AiTestResult | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)

  const baseUrlTouched = useRef(false)
  const keyDirty = useRef(false)
  const statusTimer = useRef<number | undefined>(undefined)

  const dirty = useMemo(
    () =>
      !savedConfig ||
      protocol !== savedConfig.protocol ||
      baseUrl !== savedConfig.baseUrl ||
      model !== savedConfig.model ||
      reasoningEffort !== savedConfig.reasoningEffort ||
      keyDirty.current,
    [protocol, baseUrl, model, reasoningEffort, apiKey, savedConfig]
  )
  const apiKeyConfigured = hasApiKey || (keyDirty.current && apiKey.trim() !== '')

  useEffect(() => {
    void window.api.aiGetConfig()
      .then(config => {
        const normalizedBaseUrl = config.baseUrl || DEFAULT_URLS[config.protocol]
        setProtocol(config.protocol)
        setBaseUrl(normalizedBaseUrl)
        setModel(config.model)
        setReasoningEffort(config.reasoningEffort)
        setHasApiKey(config.hasApiKey)
        setApiKey('')
        keyDirty.current = false
        setSavedConfig({ ...config, baseUrl: normalizedBaseUrl })
        setLoaded(true)
      })
      .catch(error => {
        setConfigError(error instanceof Error ? error.message : String(error))
        setLoaded(true)
      })
  }, [])

  const displayModels = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return models
    return models.filter(m =>
      m.id.toLowerCase().includes(query) ||
      (m.name?.toLowerCase().includes(query) ?? false) ||
      providerOf(m).toLowerCase().includes(query)
    )
  }, [models, searchText])

  const requestUrl = useMemo(
    () => fullRequestUrl(baseUrl, protocol),
    [baseUrl, protocol]
  )

  const flashStatus = useCallback((message: string): void => {
    setSaveStatus(message)
    if (statusTimer.current !== undefined) window.clearTimeout(statusTimer.current)
    statusTimer.current = window.setTimeout(() => setSaveStatus(null), 1600)
  }, [])

  const saveNow = useCallback(async (): Promise<AiConfig | null> => {
    setSaveStatus('保存中…')
    try {
      const config: AiConfig = {
        protocol,
        baseUrl: baseUrl.trim() || DEFAULT_URLS[protocol],
        apiKey: keyDirty.current ? apiKey.trim() : '',
        model: model.trim(),
        reasoningEffort,
        hasApiKey
      }
      keyDirty.current = false
      const saved = await window.api.aiSaveConfig(config)
      setProtocol(saved.protocol)
      setBaseUrl(saved.baseUrl)
      setModel(saved.model)
      setReasoningEffort(saved.reasoningEffort)
      setHasApiKey(saved.hasApiKey)
      setApiKey('')
      setSavedConfig(saved)
      setTestResult(null)
      flashStatus('已保存 ✓')
      return saved
    } catch (error) {
      setSaveStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }, [protocol, baseUrl, apiKey, model, reasoningEffort, hasApiKey, flashStatus])

  useEffect(() => {
    if (!loaded || !dirty || configError) return
    const timer = window.setTimeout(() => void saveNow(), 600)
    return () => window.clearTimeout(timer)
  }, [loaded, dirty, configError, saveNow])

  const fetchModels = useCallback(async (): Promise<void> => {
    setModelError(null)
    let config = savedConfig
    if (dirty) {
      const saved = await saveNow()
      if (!saved) {
        setModelError('配置保存失败，无法获取模型列表。')
        return
      }
      config = saved
    }
    setIsLoadingModels(true)
    try {
      setModels(await window.api.aiFetchModels())
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingModels(false)
    }
  }, [dirty, saveNow, savedConfig])

  const runTest = useCallback(async (): Promise<void> => {
    setTestResult(null)
    let config = savedConfig
    if (dirty) {
      const saved = await saveNow()
      if (!saved) {
        setTestResult({ ok: false, message: '配置保存失败，无法测试连接。' })
        return
      }
      config = saved
    }
    if (!config?.hasApiKey) {
      setTestResult({ ok: false, message: '请先填写 API Key，再测试模型回复。' })
      return
    }

    setIsTesting(true)
    try {
      setTestResult(await window.api.aiTestConnection())
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsTesting(false)
    }
  }, [dirty, saveNow, savedConfig])

  function switchProtocol(next: AiProtocol): void {
    setProtocol(next)
    if (!baseUrlTouched.current) setBaseUrl(DEFAULT_URLS[next])
    setTestResult(null)
  }

  return (
    <div className="library-panel ai-settings">
      <div className="panel-header-row">
        <p className="panel-title">大模型接入</p>
        {saveStatus && (
          <span className={saveStatus.startsWith('保存失败') ? 'inline-error' : 'ai-save-ok'}>{saveStatus}</span>
        )}
      </div>
      {configError && <div className="inline-error">读取 AI 配置失败：{configError}</div>}

      <div className="ai-card">
        <p className="ai-card-title">连接</p>

        <div className="ai-field">
          <span className="ai-field-label">Base URL</span>
          <div className="ai-input-row">
            <input
              type="text"
              value={baseUrl}
              placeholder={DEFAULT_URLS[protocol]}
              onChange={event => {
                baseUrlTouched.current = true
                setBaseUrl(event.target.value)
              }}
              spellCheck={false}
            />
            {baseUrl !== DEFAULT_URLS[protocol] && (
              <button className="quiet-button" onClick={() => { baseUrlTouched.current = false; setBaseUrl(DEFAULT_URLS[protocol]) }}>
                默认
              </button>
            )}
          </div>
          <span className="ai-field-note ai-endpoint-note">实际请求：{requestUrl}</span>
        </div>

        <div className="ai-field">
          <span className="ai-field-label">协议</span>
          <select
            value={protocol}
            onChange={event => switchProtocol(event.target.value as AiProtocol)}
          >
            {PROTOCOLS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className="ai-field-note">
            {PROTOCOLS.find(option => option.value === protocol)?.hint}
          </span>
        </div>

        <div className="ai-field">
          <span className="ai-field-label">API Key</span>
          <div className="ai-key-wrapper">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              placeholder={hasApiKey ? '已保存密钥 · 留空保持不变' : '粘贴你的 API Key…'}
              onChange={event => { keyDirty.current = true; setApiKey(event.target.value) }}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="ai-visibility-button"
              onClick={() => setShowApiKey(value => !value)}
              aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
              title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                <circle cx="12" cy="12" r="2.5" />
                {!showApiKey && <path d="M3 3l18 18" />}
              </svg>
            </button>
          </div>
          <span className={`ai-field-note ${apiKeyConfigured ? '' : 'ai-warn'}`}>
            {hasApiKey
              ? '已使用系统钥匙串安全保存。留空保存会保留当前密钥。'
              : apiKey.trim()
                ? '已填写，稍后会自动保存。'
                : '尚未设置 API Key。'}
          </span>
        </div>

        <div className="ai-test-row">
          <button className="quiet-button" onClick={() => void runTest()} disabled={isTesting}>
            {isTesting ? '测试中…' : '测试模型回复'}
          </button>
          {testResult && (
            <span className={`ai-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.message}
            </span>
          )}
        </div>
      </div>

      <div className="ai-card">
        <p className="ai-card-title">模型</p>
        <div className="ai-field">
          <span className="ai-field-label">当前模型</span>
          <input
            type="text"
            value={model}
            placeholder="例如 gpt-4o-mini / claude-3-5-haiku-latest"
            onChange={event => setModel(event.target.value)}
            spellCheck={false}
          />
          <span className="ai-field-note">可在下方列表中点击选用，或手动输入。</span>
        </div>

        <div className="ai-field">
          <span className="ai-field-label">思考强度</span>
          <select value={reasoningEffort} onChange={event => setReasoningEffort(event.target.value)}>
            {REASONING_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className="ai-field-note">仅对支持推理的模型生效。</span>
        </div>

        <div className="ai-browser-controls">
          <input
            type="text"
            value={searchText}
            placeholder="搜索模型…"
            onChange={event => setSearchText(event.target.value)}
            spellCheck={false}
          />
          <button className="quiet-button" onClick={() => void fetchModels()} disabled={isLoadingModels || !loaded}>
            {isLoadingModels ? '加载中…' : models.length > 0 ? '刷新' : '获取模型列表'}
          </button>
          {models.length > 0 && <span className="ai-field-note ai-model-count">{displayModels.length} / {models.length} 个</span>}
        </div>

        {modelError && <div className="inline-error">{modelError}</div>}

        {models.length === 0 && !isLoadingModels && !modelError && (
          <p className="ai-field-note">
            点击“获取模型列表”从 {baseUrl.trim() || DEFAULT_URLS[protocol]}/models 拉取，无需 API Key。
          </p>
        )}

        {displayModels.length > 0 && (
          <div className="ai-model-list">
            {displayModels.map(item => (
              <button
                key={item.id}
                type="button"
                className={`ai-model-row ${item.id === model ? 'active' : ''}`}
                onClick={() => setModel(item.id)}
                title={`选用 ${item.id}`}
              >
                <span className="ai-model-check">{item.id === model ? '✓' : ''}</span>
                <span className="ai-model-id">{item.id}</span>
                <span className="ai-model-provider">{providerOf(item)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
