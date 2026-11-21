export const DEFAULT_PI_WEB_URL = 'http://100.109.27.51:8964'
export const DEFAULT_AI_MODEL = 'opencode-go:qwen3.8-max'

export function normalizePiWebUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, '') || DEFAULT_PI_WEB_URL
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('PI_WEB_INVALID_URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('PI_WEB_INVALID_URL')
  }
  return value
}
