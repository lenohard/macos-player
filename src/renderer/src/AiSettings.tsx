import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiConfig, AiModelInfo, AiProtocol, AiTestResult } from '@shared/ipc'

const PROTOCOLS: Array<{ value: AiProtocol; label: string; hint: string }> = [
  { value: 'chat', label: 'Chat Completions', hint: 'OpenAI 兼容 · /chat/completions' },
  { value: 'response', label: 'Responses', hint: 'OpenAI · /responses' },
  { value: 'message', label: 'Messages', hint: 'Anthropic · /messages' }
]

const DEFAULT_URLS: Record<AiProtocol, string> = {
  chat: 'https://api.openai.com/v1',
  response: 'https://api.openai.com/v1',
  message: 'https://api.anthropic.com/v1'
}

const REASONING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '默认（自适应）' },
  { value: 'none', label: '禁用' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' }
]

function providerOf(modelId: string): string {
  const slash = modelId.indexOf('/')
  if (slash > 0) return modelId.slice(0, slash)
  const dash = modelId.indexOf('-')
  return dash > 0 ? modelId.slice(0, dash) : modelId
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

  const [models, setModels] = useState<AiModelInfo[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')

  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<AiTestResult | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)

  const baseUrlTouched = useRef(false)

  const dirty = useMemo(
    () =>
      !savedConfig ||
      protocol !== savedConfig.protocol ||
      baseUrl !== savedConfig.baseUrl ||
      model !== savedConfig.model ||
      reasoningEffort !== savedConfig.reasoningEffort ||
      apiKey.trim() !== '',
    [protocol, baseUrl, model, reasoningEffort, apiKey, savedConfig]
  )

  useEffect(() => {
    void window.api.aiGetConfig().then(config => {
      setProtocol(config.protocol)
      setBaseUrl(config.baseUrl || DEFAULT_URLS[config.protocol])
      setModel(config.model)
      setReasoningEffort(config.reasoningEffort)
      setHasApiKey(config.hasApiKey)
      setSavedConfig(config)
      setLoaded(true)
    })
  }, [])

  const displayModels = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return models
    return models.filter(m =>
      m.id.toLowerCase().includes(query) || providerOf(m.id).toLowerCase().includes(query)
    )
  }, [models, searchText])

  const fetchModels = useCallback(async (): Promise<void> => {
    setIsLoadingModels(true)
    setModelError(null)
    try {
      setModels(await window.api.aiFetchModels())
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoadingModels(false)
    }
  }, [])

  const runTest = useCallback(async (): Promise<void> => {
    setIsTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.api.aiTestConnection())
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsTesting(false)
    }
  }, [])

  const save = useCallback(async (): Promise<void> => {
    setIsSaving(true)
    setSaveStatus(null)
    try {
      const config: AiConfig = {
        protocol,
        baseUrl: baseUrl.trim() || DEFAULT_URLS[protocol],
        apiKey: apiKey.trim(),
        model: model.trim(),
        reasoningEffort,
        hasApiKey
      }
      const saved = await window.api.aiSaveConfig(config)
      setHasApiKey(saved.hasApiKey)
      setApiKey('')
      setSavedConfig(saved)
      setSaveStatus('已保存 ✓')
      setTestResult(null)
    } catch (error) {
      setSaveStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsSaving(false)
    }
  }, [protocol, baseUrl, apiKey, model, reasoningEffort])

  function switchProtocol(next: AiProtocol): void {
    setProtocol(next)
    // 若用户没改过 URL，则跟随协议切换默认值
    if (!baseUrlTouched.current) setBaseUrl(DEFAULT_URLS[next])
    setTestResult(null)
  }

  return (
    <div className="library-panel ai-settings">
      <div className="panel-header-row">
        <p className="panel-title">大模型接入</p>
        <button className="primary-button" onClick={() => void save()} disabled={isSaving || !dirty || !loaded}>
          {isSaving ? '保存中…' : '保存配置'}
        </button>
      </div>
      {saveStatus && <div className={saveStatus.startsWith('保存失败') ? 'inline-error' : 'ai-save-ok'}>{saveStatus}</div>}

      {/* Connection */}
      <div className="ai-card">
        <p className="ai-card-title">连接</p>

        <div className="ai-field">
          <span className="ai-field-label">协议</span>
          <div className="ai-protocols">
            {PROTOCOLS.map(option => (
              <button
                key={option.value}
                type="button"
                className={`ai-protocol ${protocol === option.value ? 'active' : ''}`}
                onClick={() => switchProtocol(option.value)}
                title={option.hint}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="ai-field-note">
            {PROTOCOLS.find(option => option.value === protocol)?.hint}
          </span>
        </div>

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
          <span className="ai-field-note">模型列表与调用统一基于 {baseUrl.trim() || DEFAULT_URLS[protocol]}</span>
        </div>

        <div className="ai-field">
          <span className="ai-field-label">API Key</span>
          <input
            type="password"
            value={apiKey}
            placeholder={hasApiKey ? '已保存密钥 · 留空保持不变' : '粘贴你的 API Key…'}
            onChange={event => setApiKey(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <span className={`ai-field-note ${hasApiKey ? '' : 'ai-warn'}`}>
            {hasApiKey ? '已使用系统钥匙串安全保存。' : '尚未设置 API Key。'}
          </span>
        </div>

        <div className="ai-test-row">
          <button className="quiet-button" onClick={() => void runTest()} disabled={isTesting}>
            {isTesting ? '测试中…' : '测试连接'}
          </button>
          {testResult && (
            <span className={`ai-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.message}
            </span>
          )}
        </div>
      </div>

      {/* Model */}
      <div className="ai-card">
        <p className="ai-card-title">模型</p>
        <div className="ai-field">
          <span className="ai-field-label">当前模型</span>
          <div className="ai-input-row">
            <input
              type="text"
              value={model}
              placeholder="例如 gpt-4o-mini / claude-3-5-haiku-latest"
              onChange={event => setModel(event.target.value)}
              spellCheck={false}
            />
            {model && (
              <button
                className="quiet-button"
                onClick={() => {
                  void navigator.clipboard.writeText(model)
                  setSaveStatus('模型 ID 已复制')
                }}
              >
                复制
              </button>
            )}
          </div>
          <span className="ai-field-note">可在下方模型浏览器中点击选用，或手动输入。</span>
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
      </div>

      {/* Model browser */}
      <div className="ai-card">
        <div className="ai-card-header">
          <p className="ai-card-title">模型浏览器</p>
          <div className="ai-browser-controls">
            {models.length > 0 && <span className="ai-field-note">{displayModels.length} / {models.length} 个</span>}
            <input
              type="text"
              value={searchText}
              placeholder="搜索模型…"
              onChange={event => setSearchText(event.target.value)}
              spellCheck={false}
            />
            <button className="quiet-button" onClick={() => void fetchModels()} disabled={isLoadingModels}>
              {isLoadingModels ? '加载中…' : models.length > 0 ? '刷新' : '获取模型列表'}
            </button>
          </div>
        </div>

        {modelError && <div className="inline-error">{modelError}</div>}

        {models.length === 0 && !isLoadingModels && !modelError && (
          <p className="ai-field-note">点击“获取模型列表”从 {baseUrl.trim() || DEFAULT_URLS[protocol]}/models 拉取。</p>
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
                <span className="ai-model-provider">{providerOf(item.id)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
