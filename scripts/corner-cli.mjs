#!/usr/bin/env node
/**
 * corner CLI — controls the corner desktop player by default, and the separate
 * Corner Web library with --web. `corner help` lists commands; --json for JSON output.
 */

import { readFileSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'

// 桌面版、网页版各写一套发现文件（端口 + token），互不共用：
//   桌面版  ~/Library/Application Support/corner/desktop-cli/{cli-port,cli-token}
//   网页版  ~/Library/Application Support/corner/{cli-port,cli-token}
const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'corner')
const DESKTOP_BUNDLE_ID = 'com.lenohard.corner.desktop'
const DESKTOP_APP_PATH = '/Applications/corner.app'
const TARGET_LABEL = { desktop: 'corner desktop', web: 'Corner Web' }
const HEALTH_TIMEOUT_MS = 1500
const START_TIMEOUT_MS = 20000
const START_POLL_MS = 400

// 目标（默认 desktop / --web 为 web）与解析后的端点。
let cliTarget = 'desktop'
let endpointPromise = null

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 所选目标的发现目录（精确一个）：桌面版 desktop-cli/，网页版 corner/ 根目录。
 * CORNER_ENDPOINT_DIR 与服务端同一变量，设置后就是该目录本身（两个客户端都不再套子目录）。
 */
function discoveryDir(target) {
  const override = process.env.CORNER_ENDPOINT_DIR?.trim()
  if (override) return override
  return target === 'desktop' ? join(APP_SUPPORT, 'desktop-cli') : APP_SUPPORT
}

function readPortFile(dir) {
  try {
    return parseInt(readFileSync(join(dir, 'cli-port'), 'utf8').trim(), 10) || null
  } catch {
    return null
  }
}

function readTokenFile(dir) {
  try {
    return readFileSync(join(dir, 'cli-token'), 'utf8').trim() || null
  } catch {
    return null
  }
}

/** 无鉴权探活，并取服务声明的 mode（旧版本没有 mode 时为 null）。 */
async function probeHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      redirect: 'error', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    if (data?.ok !== true) return null
    return { mode: typeof data.mode === 'string' ? data.mode : null }
  } catch {
    return null
  }
}

/** 在所选目标的发现目录里找端点；顺手记录指向别的目标/旧版本的情况。 */
async function scanTarget(target, observed) {
  const dir = discoveryDir(target)
  const port = readPortFile(dir)
  if (!port) return null
  const health = await probeHealth(port)
  if (!health) return null
  if (health.mode === target) return { dir, port }
  observed.push({ dir, mode: health.mode })
  return null
}

function wrongTargetError(target, observed) {
  const lines = observed.map(o => `  ${o.dir} → ${o.mode ? `mode=${o.mode}` : '未声明 mode'}`)
  const modeHint = observed.some(o => !o.mode)
    ? '\n服务没有在 /health 声明 mode，无法确认它属于哪个目标；请把对应的 App／服务更新到最新版本后重试。'
    : ''
  const targetHint = target === 'web'
    ? 'corner --web 只连接 Corner Web 的发现文件；要控制桌面版请去掉 --web。'
    : '桌面版只使用 desktop-cli/ 下的发现文件；要操作网页库请加 --web。'
  return new Error(
    '发现文件指向另一个目标，已拒绝使用（不会用它的 token，也不会向它发请求）：\n' +
    `${lines.join('\n')}${modeHint}\n${targetHint}`
  )
}

function launchDesktopApp() {
  for (const args of [['-b', DESKTOP_BUNDLE_ID], ['-a', DESKTOP_APP_PATH]]) {
    try {
      execFileSync('open', args, { stdio: 'ignore', timeout: 5000 })
      return true
    } catch {
      // bundle id 找不到时再试安装路径
    }
  }
  return false
}

/** 桌面版：发现文件缺失/过期时拉起已安装的 App 并有限等待；网页版永不自动启动。 */
async function startDesktop(observed) {
  if (process.env.CORNER_ENDPOINT_DIR?.trim()) {
    throw new Error('已设置 CORNER_ENDPOINT_DIR（隔离测试模式），CLI 不自动启动桌面 App：' +
      '经 LaunchServices 启动的 App 收不到该环境变量，会连到真实曲库。请先手动启动一个使用该目录的桌面实例。')
  }
  if (!launchDesktopApp()) {
    throw new Error(`无法启动 corner 桌面 App（bundle id ${DESKTOP_BUNDLE_ID} 或 ${DESKTOP_APP_PATH}）。` +
      '请确认已安装 corner.app，或手动启动后重试。')
  }
  console.error('Starting corner desktop app...')
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(START_POLL_MS)
    const hit = await scanTarget('desktop', observed)
    if (hit) return hit
  }
  throw new Error(`已尝试启动 corner 桌面 App，但 ${START_TIMEOUT_MS / 1000} 秒内没有在 ` +
    `${discoveryDir('desktop')} 上发现声明 mode=desktop 的服务。` +
    '若 App 已在运行，请完全退出（⌘Q）后重试；若它仍是旧版本（发现文件写在 corner/ 根目录），请升级后再试。')
}

function withToken(target, { dir, port }) {
  const token = readTokenFile(dir)
  if (!token) {
    throw new Error(`发现文件不完整：缺少 ${join(dir, 'cli-token')}。请重启 ${TARGET_LABEL[target]} 以重建发现文件。`)
  }
  return { dir, port, token }
}

/** 解析端点：先确认 /health 的 mode 与所选目标一致，之后才读 token、发请求。 */
async function resolveEndpoint(target) {
  const observed = []
  const hit = await scanTarget(target, observed)
  if (hit) return withToken(target, hit)
  if (observed.length > 0) throw wrongTargetError(target, observed)
  if (target === 'web') {
    throw new Error(`Corner Web 服务未运行：${discoveryDir('web')} 下没有可用的 cli-port。` +
      'CLI 不会自动启动网页版；请先启动后台服务（launchctl kickstart -k gui/$(id -u)/com.user.corner-web）。')
  }
  return withToken(target, await startDesktop(observed))
}

function endpoint(target) {
  endpointPromise ??= resolveEndpoint(target)
  return endpointPromise
}

async function request(path, method = 'GET', body = null) {
  const { port, token } = await endpoint(cliTarget)
  const headers = { Authorization: `Bearer ${token}` }
  // Share Hub's same-origin proxy requires JSON semantics for DELETE too,
  // even when the endpoint has no request body.
  if (body || method === 'DELETE') headers['Content-Type'] = 'application/json'
  const options = { method, headers, redirect: 'error' }
  if (body) options.body = JSON.stringify(body)

  // 单次请求、不重试：mutating 请求重放会重复写入。
  const res = await fetch(`http://127.0.0.1:${port}${path}`, options)
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
  if (data === null) throw new Error('服务返回的不是 JSON。')
  return data
}

function isJsonFlag(arg) {
  return arg === '--json' || arg === '-j'
}

// Positional args (excludes --json/-j, keeps everything else incl. negative numbers)
function positional(args) {
  return args.filter(a => !isJsonFlag(a))
}

function print(data, useJson) {
  if (useJson) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(formatHuman(data))
  }
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60)
  return `${minutes}:${remaining.toString().padStart(2, '0')}`
}

function formatHuman(data) {
  if (!data) return ''

  // song metadata
  if (typeof data.intro === 'string' && data.lyrics !== undefined && data.found !== undefined) {
    const lines = []
    if (data.title) lines.push(`${data.title}${data.source ? ` [${data.source}]` : ''}`)
    if (data.path) lines.push(`path: ${data.path}`)
    lines.push('', '—— 介绍 ——', data.intro || (data.found ? '暂无介绍。' : `未找到：${data.reason || '未知原因'}`))
    lines.push('', '—— 歌词 ——')
    const lyrics = Array.isArray(data.lyricsBilingual) && data.lyricsBilingual.length > 0
      ? data.lyricsBilingual
      : data.lyrics
    if (Array.isArray(lyrics)) {
      if (lyrics.length === 0) lines.push(data.found ? '暂无歌词。' : '未找到歌词。')
      for (const line of lyrics) {
        if (line.original) lines.push(line.original)
        if (line.translated) lines.push(line.translated)
      }
    } else {
      lines.push(data.lyrics || (data.found ? '暂无歌词。' : '未找到歌词。'))
    }
    return lines.join('\\n')
  }

  // song info task list
  if (data.tasks && Array.isArray(data.tasks)) {
    if (data.tasks.length === 0) return 'No song info tasks.'
    return data.tasks.map((t, i) => {
      const when = new Date(t.startedAt).toLocaleString()
      const artist = t.artist ? ` — ${t.artist}` : ''
      const tools = t.toolCallCount > 0
        ? ` | tools: ${t.toolCallCount}${t.currentTool ? ` (running: ${t.currentTool})` : ''}`
        : ''
      const msg = t.message ? ` | ${t.message}` : ''
      return `${i + 1}. [${t.status}] ${t.title}${artist} | ${t.model} | ${when}${tools}${msg}\n   id: ${t.id}`
    }).join('\n')
  }

  // playlist list
  if (Array.isArray(data) && data[0]?.name !== undefined && data[0]?.trackCount !== undefined) {
    if (data.length === 0) return 'No playlists.'
    return data.map((p, i) => `${i + 1}. ${p.name} (${p.trackCount} tracks, id: ${p.id})`).join('\n')
  }

  // single playlist summary (create/rename result)
  if (data.name !== undefined && data.trackCount !== undefined && data.id !== undefined) {
    return `${data.name} (${data.trackCount} tracks, id: ${data.id})`
  }

  // source list
  if (Array.isArray(data) && data[0]?.type !== undefined) {
    return data.map((s, i) => `${i + 1}. ${s.name} [${s.type}] (id: ${s.id})`).join('\n')
  }

  // search / favorites results
  if (data.tracks && Array.isArray(data.tracks)) {
    if (data.tracks.length === 0) return 'No tracks found.'
    return data.tracks.map((t, i) =>
      `${i + 1}. ${t.title} — ${t.artist || 'unknown'} [${t.sourceId}] (id: ${t.id})`
    ).join('\n')
  }

  // history entries
  if (data.entries && Array.isArray(data.entries)) {
    if (data.entries.length === 0) return 'No history.'
    return data.entries.map((e, i) =>
      `${i + 1}. ${e.track.title} — ${e.track.artist || 'unknown'} (${new Date(e.playedAt).toLocaleString()})`
    ).join('\n')
  }

  // play result
  if (data.track) {
    return `▶ ${data.track.title} — ${data.track.artist || 'unknown'} [${data.track.sourceId}]`
  }
  if (data.trackCount !== undefined && data.ok) {
    return `▶ Playing (${data.trackCount} tracks)`
  }

  // status with playback info
  if (data.ok !== undefined && data.running) {
    const label = TARGET_LABEL[cliTarget]
    const pb = data.playback
    if (!pb) return `${label} is running (no playback info)`

    const playIcon = pb.isPlaying ? '▶' : '⏸'
    const lines = [`${label} is running`]

    if (pb.currentTrack) {
      lines.push(`  ${playIcon} ${pb.currentTrack.title} — ${pb.currentTrack.artist || 'unknown'}`)
      lines.push(`    source: ${pb.currentTrack.sourceId} | id: ${pb.currentTrack.id}`)
      lines.push(`    ${formatTime(pb.positionSec)} / ${formatTime(pb.durationSec)} | volume: ${Math.round((pb.volume ?? 0) * 100)}%`)
    } else {
      lines.push(`  ${playIcon} No track loaded`)
    }

    lines.push('')
    lines.push(`  queue: ${pb.queueLength} tracks | index: ${pb.currentIndex}`)
    lines.push(`  shuffle: ${pb.shuffle ? 'on' : 'off'} | repeat: ${pb.repeatMode}`)

    return lines.join('\n')
  }

  // download result
  if (data.ok && data.path && data.bytes !== undefined) {
    const sizeMB = (data.bytes / (1024 * 1024)).toFixed(1)
    return `Downloaded: ${data.path} (${sizeMB} MB, source: ${data.source})`
  }

  // simple ok response
  if (data.ok !== undefined && data.ok) return 'OK'

  // fallback
  if (data.ok !== undefined && data.error) return `Error: ${data.error}`
  return JSON.stringify(data, null, 2)
}

const WEB_UNSUPPORTED = new Map([
  ['toggle', '播放控制由浏览器播放页负责'],
  ['next', '播放控制由浏览器播放页负责'],
  ['prev', '播放控制由浏览器播放页负责'],
  ['shuffle', '播放控制由浏览器播放页负责'],
  ['repeat', '播放控制由浏览器播放页负责'],
  ['volume', '播放控制由浏览器播放页负责'],
  ['seek', '播放控制由浏览器播放页负责'],
  ['play', '播放控制由浏览器播放页负责'],
  ['events', '网页版不提供播放事件流'],
  ['library', '网页版的音乐库更新（/libraries/update）暂未开放']
])

const HELP = `corner CLI — control the corner desktop player, or manage the Corner Web library

Usage:
  corner <command> [--json]               desktop app (default); starts it if needed
  corner --web <command> [--json]         Corner Web library service (never auto-started)
                                          --web only counts as the first argument; elsewhere it is a value
  corner help                             show this help

Both targets (desktop by default; add --web for the Web library):
  corner status                           service status (playback only on desktop)
  corner playlists                        list playlists
  corner playlist create <name>           create a playlist
  corner playlist rename <id> <name>      rename a playlist
  corner playlist delete <id>             delete a playlist
  corner playlist tracks <id>             list playlist tracks
  corner playlist add <id> <trackId>      add a track to a playlist
  corner playlist remove <id> <trackId>   remove a track from a playlist
  corner sources                          list sources
  corner search <query>                   search tracks
  corner favorites                        list favorite tracks
  corner favorite <trackId>               add to favorites
  corner unfavorite <trackId>             remove from favorites
  corner history [limit]                  show recently played tracks
  corner track edit <trackId> [--title <title>] [--artist <artist>|--clear-artist]
                                          edit library metadata (does not write file tags)
  corner track delete <trackId> --yes     move local file to Trash and soft-delete index
  corner download <trackId> [--out <path>] download track audio to local disk
  corner song-info --prompt <text>        query and save song intro/lyrics
  corner song-info --get <id|path|title>  read saved song metadata
  corner song-info --tasks                list search tasks (running + recent history)
  corner song-info --result <id>          read a task's result snapshot
  corner song-info --cancel <id>          cancel a running task
  corner song-info --retry <id>           re-run the original request (new task)
  corner song-info --delete <id>          delete a finished task
  corner export [file]                    export playlists & favorites to JSON
  corner import <file>                    import playlists & favorites from backup

Desktop only (rejected when --web is given):
  corner toggle                           toggle play/pause
  corner next | corner prev               next / previous track
  corner shuffle | corner repeat          toggle shuffle / cycle repeat mode
  corner volume <0..1>                    set volume
  corner seek <seconds> | +<s> | -<s>     seek (absolute or relative)
  corner play --playlist-id <id>          play a playlist
  corner play --track-id <id>             play a single track
  corner play --query <query>             search & play first match
  corner play --random [count]            play random tracks (default 20)
  corner events                           stream playback events (SSE)
  corner libraries                        list imported cloud libraries
  corner library update <rootPath>        rescan one imported library

Each target has its own discovery files, so commands never switch library silently
(CORNER_ENDPOINT_DIR, used for isolated testing, overrides the directory itself for both):
  desktop  ~/Library/Application Support/corner/desktop-cli/{cli-port,cli-token}
  web      ~/Library/Application Support/corner/{cli-port,cli-token}
The desktop app is started on demand; the Web service must already be running.

Add --json or -j to any command for JSON output.`

async function streamEvents() {
  const { port, token } = await endpoint(cliTarget)
  const res = await fetch(`http://127.0.0.1:${port}/events`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error'
  })
  if (!res.ok) {
    console.error(`HTTP ${res.status}`)
    process.exit(1)
  }
  process.stdout.write('Listening for playback events (Ctrl-C to stop)...\n')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    process.stdout.write(decoder.decode(value, { stream: true }))
  }
}

async function main() {
  // 目标选择：默认桌面版；--web 只在第一个位置作为全局选项生效。
  // 其他位置的 '--web' 一律当值处理（如 song-info --prompt '--web'、名为 --web 的歌单），
  // 否则会让某些命令被悄悄改到另一个库上执行。
  const argv = process.argv.slice(2)
  const leadingWeb = argv[0] === '--web'
  cliTarget = leadingWeb ? 'web' : 'desktop'
  const args = leadingWeb ? argv.slice(1) : argv
  if (args.length === 0) {
    console.log(HELP)
    process.exit(0)
  }

  const cmd = args[0]
  const rest = args.slice(1)
  const useJson = rest.some(isJsonFlag)
  const flags = positional(rest)

  // 网页库只有读取/整理命令：播放控制、播放事件流、音乐库更新仅桌面版支持。
  if (cliTarget === 'web' && WEB_UNSUPPORTED.has(cmd)) {
    console.error(`corner --web 不支持 ${cmd}：${WEB_UNSUPPORTED.get(cmd)}。`)
    console.error(`去掉 --web 才会作用于桌面版：corner ${args.join(' ')}`)
    process.exit(1)
  }

  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP)
        break

      case 'playlists': {
        const data = await request('/playlists')
        print(data, useJson)
        break
      }
      case 'sources': {
        const data = await request('/sources')
        print(data, useJson)
        break
      }
      case 'libraries': {
        const data = await request('/libraries')
        print(data, useJson)
        break
      }
      case 'library': {
        const [sub, ...subArgs] = flags
        switch (sub) {
          case 'update': {
            if (subArgs.length === 0) {
              console.error('Usage: corner library update <rootPath>')
              process.exit(1)
            }
            const data = await request('/libraries/update', 'POST', { rootPath: subArgs.join(' ') })
            print(data, useJson)
            break
          }
          default:
            console.error('Usage: corner library <update> ...')
            process.exit(1)
        }
        break
      }
      case 'search': {
        if (flags.length === 0) {
          console.error('Usage: corner search <query>')
          process.exit(1)
        }
        const query = flags.join(' ')
        const data = await request(`/search?q=${encodeURIComponent(query)}&limit=20`)
        print(data, useJson)
        break
      }
      case 'play': {
        const playlistIdx = args.indexOf('--playlist-id')
        const trackIdx = args.indexOf('--track-id')
        const queryIdx = args.indexOf('--query')
        const randomIdx = args.indexOf('--random')

        if (playlistIdx >= 0 && playlistIdx + 1 < args.length) {
          const data = await request('/play', 'POST', { playlistId: args[playlistIdx + 1] })
          print(data, useJson)
        } else if (trackIdx >= 0 && trackIdx + 1 < args.length) {
          const data = await request('/play', 'POST', { trackId: args[trackIdx + 1] })
          print(data, useJson)
        } else if (queryIdx >= 0 && queryIdx + 1 < args.length) {
          const data = await request('/play', 'POST', { query: args[queryIdx + 1] })
          print(data, useJson)
        } else if (randomIdx >= 0) {
          const next = args[randomIdx + 1]
          const count = next === undefined || next.startsWith('--') ? 20 : (/^\d+$/.test(next) ? Number(next) : NaN)
          if (!Number.isInteger(count) || count < 1 || count > 500) {
            console.error('Usage: corner play --random [count]   (count: 1-500, default 20)')
            process.exit(1)
          }
          const data = await request('/play', 'POST', { random: count })
          print(data, useJson)
        } else {
          console.error('Usage: corner play --playlist-id <id> | --track-id <id> | --query <query> | --random [count]')
          process.exit(1)
        }
        break
      }
      case 'toggle': {
        const data = await request('/toggle-play', 'POST')
        print(data, useJson)
        break
      }
      case 'next': {
        const data = await request('/next', 'POST')
        print(data, useJson)
        break
      }
      case 'prev': {
        const data = await request('/prev', 'POST')
        print(data, useJson)
        break
      }
      case 'shuffle': {
        const data = await request('/shuffle', 'POST')
        print(data, useJson)
        break
      }
      case 'repeat': {
        const data = await request('/repeat', 'POST')
        print(data, useJson)
        break
      }
      case 'volume': {
        if (flags.length === 0) {
          console.error('Usage: corner volume <0..1>')
          process.exit(1)
        }
        const volume = parseFloat(flags[0])
        if (!Number.isFinite(volume)) {
          console.error('Invalid volume (expected 0..1)')
          process.exit(1)
        }
        const data = await request('/volume', 'POST', { volume })
        print(data, useJson)
        break
      }
      case 'seek': {
        if (flags.length === 0) {
          console.error('Usage: corner seek <seconds> | +<seconds> | -<seconds>')
          process.exit(1)
        }
        const arg = flags[0]
        const value = parseFloat(arg)
        if (!Number.isFinite(value)) {
          console.error('Invalid seek position')
          process.exit(1)
        }
        const body = arg.startsWith('+') || arg.startsWith('-')
          ? { offsetSec: value }
          : { positionSec: value }
        const data = await request('/seek', 'POST', body)
        print(data, useJson)
        break
      }
      case 'favorites':
      case 'favs': {
        const data = await request('/favorites')
        print(data, useJson)
        break
      }
      case 'favorite':
      case 'fav': {
        if (flags.length === 0) {
          console.error('Usage: corner favorite <trackId>')
          process.exit(1)
        }
        const data = await request(`/favorites/${encodeURIComponent(flags[0])}`, 'PUT')
        print(data, useJson)
        break
      }
      case 'unfavorite':
      case 'unfav': {
        if (flags.length === 0) {
          console.error('Usage: corner unfavorite <trackId>')
          process.exit(1)
        }
        const data = await request(`/favorites/${encodeURIComponent(flags[0])}`, 'DELETE')
        print(data, useJson)
        break
      }
      case 'history': {
        const limit = flags[0] ? `?limit=${encodeURIComponent(flags[0])}` : ''
        const data = await request(`/history${limit}`)
        print(data, useJson)
        break
      }
      case 'track': {
        const [sub, ...subArgs] = flags
        const trackId = subArgs[0]
        if (!trackId) {
          console.error('Usage: corner track <edit|delete> <trackId> ...')
          process.exit(1)
        }
        if (sub === 'edit') {
          const valueAfter = flag => {
            const index = args.indexOf(flag)
            if (index < 0 || index + 1 >= args.length || args[index + 1].startsWith('--')) return undefined
            return args[index + 1]
          }
          const title = valueAfter('--title')
          const artist = valueAfter('--artist')
          const hasArtistOption = args.includes('--artist')
          const clearArtist = args.includes('--clear-artist')
          if (title === undefined && artist === undefined && !clearArtist) {
            console.error('Usage: corner track edit <trackId> [--title <title>] [--artist <artist>|--clear-artist]')
            process.exit(1)
          }
          if (hasArtistOption && clearArtist) {
            console.error('--artist and --clear-artist are mutually exclusive')
            process.exit(1)
          }
          const current = await request(`/tracks/${encodeURIComponent(trackId)}`)
          const body = {
            title: title === undefined ? current.title : title,
            artist: clearArtist ? null : (artist === undefined ? current.artist : artist)
          }
          const data = await request(`/tracks/${encodeURIComponent(trackId)}`, 'PATCH', body)
          if (useJson) print(data, true)
          else console.log(`Updated: ${data.title} — ${data.artist || 'unknown'} (id: ${data.id})`)
        } else if (sub === 'delete') {
          if (!args.includes('--yes')) {
            console.error('Refusing to delete without explicit confirmation. Re-run with --yes to move the original file to Trash.')
            process.exit(1)
          }
          const data = await request(`/tracks/${encodeURIComponent(trackId)}`, 'DELETE')
          if (useJson) print(data, true)
          else console.log(`Moved to Trash: ${data.track.title} — ${data.track.artist || 'unknown'}\n${data.track.path}`)
        } else {
          console.error('Usage: corner track <edit|delete> <trackId> ...')
          process.exit(1)
        }
        break
      }
      case 'download': {
        if (flags.length === 0) {
          console.error('Usage: corner download <trackId> [--out <path>]')
          process.exit(1)
        }
        const trackId = flags[0]
        const outIdx = args.indexOf('--out')
        const body = { trackId }
        if (outIdx >= 0 && outIdx + 1 < args.length) {
          body.dest = args[outIdx + 1]
        }
        const data = await request('/download', 'POST', body)
        print(data, useJson)
        break
      }
      case 'song-info':
      case 'song': {
        const SONG_INFO_USAGE = 'Usage: corner song-info --prompt "<song and path>" [--model <model>] [--json] | --get <id|path|title> [--json] | --tasks [--json] | --result <id> [--json] | --cancel <id> | --retry <id> | --delete <id>'
        if (args.includes('--help') || args.includes('-h')) {
          console.log(SONG_INFO_USAGE)
          break
        }
        const tasksIdx = args.indexOf('--tasks')
        const resultIdx = args.indexOf('--result')
        const cancelIdx = args.indexOf('--cancel')
        const retryIdx = args.indexOf('--retry')
        const deleteIdx = args.indexOf('--delete')
        const promptIdx = args.indexOf('--prompt')
        const modelIdx = args.indexOf('--model')
        const getIdx = args.indexOf('--get')
        if (tasksIdx >= 0) {
          const data = await request('/api/music/song-info/tasks')
          print(data, useJson)
        } else if (resultIdx >= 0 && resultIdx + 1 < args.length) {
          const id = args[resultIdx + 1]
          const data = await request(`/api/music/song-info/tasks/${encodeURIComponent(id)}/result`)
          print(data, useJson)
        } else if (cancelIdx >= 0 && cancelIdx + 1 < args.length) {
          const id = args[cancelIdx + 1]
          const data = await request(`/api/music/song-info/tasks/${encodeURIComponent(id)}/cancel`, 'POST')
          if (useJson) print(data, true)
          else {
            console.log(`已取消任务 ${id}`)
            if (data.task && data.task.message) console.log(`提示：${data.task.message}`)
          }
        } else if (retryIdx >= 0 && retryIdx + 1 < args.length) {
          const id = args[retryIdx + 1]
          const data = await request(`/api/music/song-info/tasks/${encodeURIComponent(id)}/retry`, 'POST')
          if (useJson) print(data, true)
          else console.log(`已重新发起检索，新任务：${data.requestId}`)
        } else if (deleteIdx >= 0 && deleteIdx + 1 < args.length) {
          const id = args[deleteIdx + 1]
          const data = await request(`/api/music/song-info/tasks/${encodeURIComponent(id)}`, 'DELETE')
          if (useJson) print(data, true)
          else console.log(`已删除任务 ${id}`)
        } else if (getIdx >= 0 && getIdx + 1 < args.length) {
          const identifier = args[getIdx + 1]
          const data = await request(`/api/music/song-info?path=${encodeURIComponent(identifier)}`)
          print(data, useJson)
        } else if (promptIdx >= 0 && promptIdx + 1 < args.length) {
          const prompt = args[promptIdx + 1]
          const modelId = modelIdx >= 0 && modelIdx + 1 < args.length ? args[modelIdx + 1] : undefined
          const data = await request('/api/music/song-info', 'POST', { prompt, model: modelId })
          print(data, useJson)
        } else {
          console.error(SONG_INFO_USAGE)
          process.exit(1)
        }
        break
      }
      case 'export': {
        const data = await request('/export')
        let file = flags[0]
        if (!file && !useJson) {
          file = `corner-backup-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`
        }
        if (file) {
          writeFileSync(file, JSON.stringify(data, null, 2))
          const playlistCount = data.playlists.length
          const favCount = data.favorites.length
          if (useJson) print(data, true)
          else console.log(`Exported ${playlistCount} playlists, ${favCount} favorites → ${file}`)
        } else {
          print(data, useJson)
        }
        break
      }
      case 'import': {
        if (flags.length === 0) {
          console.error('Usage: corner import <backup.json>')
          process.exit(1)
        }
        const data = JSON.parse(readFileSync(flags[0], 'utf8'))
        const result = await request('/import', 'POST', data)
        if (useJson) print(result, true)
        else {
          console.log(`导入完成：新建歌单 ${result.playlistsCreated} 个、合并到已有歌单 ${result.playlistsMatched} 个；` +
            `新增曲目 ${result.tracksAdded} 首、未找到 ${result.tracksMissing} 首；` +
            `收藏新增 ${result.favoritesAdded} 首、已存在 ${result.favoritesExisting} 首。`)
        }
        break
      }
      case 'events': {
        await streamEvents()
        break
      }
      case 'playlist': {
        const [sub, ...subArgs] = flags
        switch (sub) {
          case 'create': {
            if (subArgs.length === 0) {
              console.error('Usage: corner playlist create <name>')
              process.exit(1)
            }
            const data = await request('/playlists', 'POST', { name: subArgs.join(' ') })
            print(data, useJson)
            break
          }
          case 'rename': {
            if (subArgs.length < 2) {
              console.error('Usage: corner playlist rename <id> <name>')
              process.exit(1)
            }
            const data = await request(`/playlists/${encodeURIComponent(subArgs[0])}`, 'PATCH', { name: subArgs.slice(1).join(' ') })
            print(data, useJson)
            break
          }
          case 'delete': {
            if (subArgs.length === 0) {
              console.error('Usage: corner playlist delete <id>')
              process.exit(1)
            }
            const data = await request(`/playlists/${encodeURIComponent(subArgs[0])}`, 'DELETE')
            print(data, useJson)
            break
          }
          case 'tracks': {
            if (subArgs.length === 0) {
              console.error('Usage: corner playlist tracks <id>')
              process.exit(1)
            }
            const data = await request(`/playlists/${encodeURIComponent(subArgs[0])}/tracks`)
            print(data, useJson)
            break
          }
          case 'add': {
            if (subArgs.length < 2) {
              console.error('Usage: corner playlist add <id> <trackId>')
              process.exit(1)
            }
            const data = await request(`/playlists/${encodeURIComponent(subArgs[0])}/tracks`, 'POST', { trackId: subArgs[1] })
            print(data, useJson)
            break
          }
          case 'remove': {
            if (subArgs.length < 2) {
              console.error('Usage: corner playlist remove <id> <trackId>')
              process.exit(1)
            }
            const data = await request(`/playlists/${encodeURIComponent(subArgs[0])}/tracks/${encodeURIComponent(subArgs[1])}`, 'DELETE')
            print(data, useJson)
            break
          }
          default:
            console.error('Usage: corner playlist <create|rename|delete|tracks|add|remove> ...')
            process.exit(1)
        }
        break
      }
      case 'status': {
        const data = await request('/status')
        print(data, useJson)
        break
      }
      default:
        console.error(`Unknown command: ${cmd}`)
        console.error(HELP)
        process.exit(1)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

main()
