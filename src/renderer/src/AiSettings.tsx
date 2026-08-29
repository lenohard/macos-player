import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiConfig, AiModelInfo, AiTestResult } from '@shared/ipc'

const DEFAULT_PI_WEB_URL = 'http://100.109.27.51:8964'
const DEFAULT_MODEL = 'qwen/qwen3.7-plus'

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

export default function AiSettings() {
  const [piWebUrl, setPiWebUrl] = useState(DEFAULT_PI_WEB_URL)
  const [defaultModel, setDefaultModel] = useState(DEFAULT_MODEL)
  const [songInfoPrompt, setSongInfoPrompt] = useState('')

  const [savedConfig, setSavedConfig] = useState<AiConfig | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)

  const [models, setModels] = useState<AiModelInfo[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')

  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<AiTestResult | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)

  const urlTouched = useRef(false)
  const autoFetchAttempted = useRef(false)
  const statusTimer = useRef<number | undefined>(undefined)

  const dirty = useMemo(
    () =>
      !savedConfig ||
      piWebUrl !== savedConfig.piWebUrl ||
      defaultModel !== savedConfig.defaultModel ||
      songInfoPrompt !== (savedConfig.songInfoPrompt ?? ''),
    [piWebUrl, defaultModel, songInfoPrompt, savedConfig]
  )

  useEffect(() => {
    void window.api.aiGetConfig()
      .then(config => {
        setPiWebUrl(config.piWebUrl || DEFAULT_PI_WEB_URL)
        setDefaultModel(config.defaultModel || DEFAULT_MODEL)
        setSongInfoPrompt(config.songInfoPrompt ?? '')
        setSavedConfig(config)
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

  const flashStatus = useCallback((message: string): void => {
    setSaveStatus(message)
    if (statusTimer.current !== undefined) window.clearTimeout(statusTimer.current)
    statusTimer.current = window.setTimeout(() => setSaveStatus(null), 1600)
  }, [])

  const saveNow = useCallback(async (): Promise<AiConfig | null> => {
    setSaveStatus('保存中…')
    try {
      const config: AiConfig = {
        piWebUrl: piWebUrl.trim() || DEFAULT_PI_WEB_URL,
        defaultModel: defaultModel.trim() || DEFAULT_MODEL,
        songInfoPrompt: songInfoPrompt.trim()
      }
      const saved = await window.api.aiSaveConfig(config)
      setPiWebUrl(saved.piWebUrl)
      setDefaultModel(saved.defaultModel)
      setSongInfoPrompt(saved.songInfoPrompt ?? '')
      setSavedConfig(saved)
      setTestResult(null)
      flashStatus('已保存 ✓')
      return saved
    } catch (error) {
      setSaveStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }, [piWebUrl, defaultModel, songInfoPrompt, flashStatus])

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

  useEffect(() => {
    if (!loaded || configError || autoFetchAttempted.current) return
    autoFetchAttempted.current = true
    void fetchModels()
  }, [loaded, configError, fetchModels])

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
    setIsTesting(true)
    try {
      setTestResult(await window.api.aiTestConnection())
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsTesting(false)
    }
  }, [dirty, saveNow, savedConfig])

  return (
    <div className="library-panel ai-settings">
      <div className="panel-header-row">
        <p className="panel-title">pi-web Agent</p>
        {saveStatus && (
          <span className={saveStatus.startsWith('保存失败') ? 'inline-error' : 'ai-save-ok'}>{saveStatus}</span>
        )}
      </div>
      {configError && <div className="inline-error">读取 AI 配置失败：{configError}</div>}

      <div className="ai-card">
        <p className="ai-card-title">连接</p>

        <div className="ai-field">
          <span className="ai-field-label">pi-web 地址</span>
          <div className="ai-input-row">
            <input
              type="text"
              value={piWebUrl}
              placeholder={DEFAULT_PI_WEB_URL}
              onChange={event => {
                urlTouched.current = true
                setPiWebUrl(event.target.value)
              }}
              spellCheck={false}
            />
            {piWebUrl !== DEFAULT_PI_WEB_URL && (
              <button className="quiet-button" onClick={() => { urlTouched.current = false; setPiWebUrl(DEFAULT_PI_WEB_URL) }}>
                默认
              </button>
            )}
          </div>
          <span className="ai-field-note">pi-web 本地服务地址，默认为 {DEFAULT_PI_WEB_URL}</span>
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

      <div className="ai-card">
        <div className="ai-card-heading">
          <p className="ai-card-title">模型</p>
          {defaultModel && <span className="ai-selected-model" title={defaultModel}>已选 {defaultModel}</span>}
        </div>

        <div className="ai-field">
          <span className="ai-field-label">默认模型</span>
          <input
            type="text"
            value={defaultModel}
            placeholder={DEFAULT_MODEL}
            onChange={event => setDefaultModel(event.target.value)}
            spellCheck={false}
          />
          <span className="ai-field-note">默认模型 ID，如 {DEFAULT_MODEL}</span>
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
            {isLoadingModels ? '加载中…' : '刷新'}
          </button>
          {models.length > 0 && <span className="ai-field-note ai-model-count">{displayModels.length} / {models.length} 个</span>}
        </div>

        {modelError && <div className="inline-error">{modelError}</div>}

        {models.length === 0 && (
          <p className="ai-model-empty">
            {isLoadingModels ? '正在获取模型列表…' : '暂无模型；可刷新获取，或直接输入模型 ID。'}
          </p>
        )}

        {displayModels.length > 0 && (
          <div className="ai-model-list">
            {displayModels.map(item => {
              const fullId = `${providerOf(item)}:${item.id}`
              return (
                <button
                  key={fullId}
                  type="button"
                  className={`ai-model-row ${fullId === defaultModel ? 'active' : ''}`}
                  onClick={() => setDefaultModel(fullId)}
                  title={`选用 ${fullId}`}
                >
                  <span className="ai-model-check">{fullId === defaultModel ? '✓' : ''}</span>
                  <span className="ai-model-id">{item.id}</span>
                  <span className="ai-model-provider">{providerOf(item)}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="ai-card">
        <div className="ai-card-heading">
          <p className="ai-card-title">歌曲信息搜索提示词</p>
          {songInfoPrompt && (
            <button className="quiet-button" onClick={() => setSongInfoPrompt('')}>恢复默认</button>
          )}
        </div>
        <div className="ai-field">
          <textarea
            className="ai-prompt-input"
            value={songInfoPrompt}
            placeholder={'留空使用内置默认提示词。支持 {query} 占位符：用户请求会替换到该位置；未提供时自动追加到末尾。'}
            onChange={event => setSongInfoPrompt(event.target.value)}
            rows={10}
            spellCheck={false}
          />
          <span className="ai-field-note">
            {'提示词必须要求模型最终只输出一行 JSON，字段固定为 found / intro / lyrics / lyricsBilingual / reason（程序按此解析入库）。'}
          </span>
        </div>
      </div>
    </div>
  )
}