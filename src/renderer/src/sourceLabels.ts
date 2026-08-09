export function trackSourceLabel(sourceId: string): string {
  if (sourceId === 'local') return '本地音乐'
  if (sourceId === 'baidu') return '百度网盘'
  if (sourceId === 'quark') return 'WebDAV'
  return '其他来源'
}
