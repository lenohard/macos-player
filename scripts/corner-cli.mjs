#!/usr/bin/env node
/**
 * corner CLI — remote control for the corner music player.
 *
 * Usage:
 *   corner help                                show this help
 *   corner status                              show playback status
 *   corner toggle                              toggle play/pause
 *   corner next                                next track
 *   corner prev                                previous track
 *   corner shuffle                             toggle shuffle
 *   corner repeat                              cycle repeat mode (off → all → one)
 *   corner volume <0..1>                       set volume
 *   corner seek <seconds> | +<seconds> | -<seconds>   seek (absolute or relative)
 *   corner playlists                           list playlists
 *   corner playlist create <name>              create a playlist
 *   corner playlist rename <id> <name>         rename a playlist
 *   corner playlist delete <id>                delete a playlist
 *   corner playlist tracks <id>                list playlist tracks
 *   corner playlist add <id> <trackId>         add a track to a playlist
 *   corner playlist remove <id> <trackId>      remove a track from a playlist
 *   corner sources                             list sources
 *   corner search <query>                      search tracks
 *   corner play --playlist-id <id>             play a playlist
 *   corner play --track-id <id>               play a single track
 *   corner play --query <query>               search & play first match
 *   corner favorites                           list favorite tracks
 *   corner favorite <trackId>                  add to favorites
 *   corner unfavorite <trackId>                remove from favorites
 *   corner history [limit]                     show recently played tracks
 *   corner download <trackId> [--out <path>]        download track audio to local disk
 *   corner song-info --prompt "<song and path>" [--model <model>]  query song info
 *   corner song-info --get <id|path|title>      read saved song info
 *   corner events                              stream playback events (SSE)
 *
 * JSON output: add --json to any command.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

const PORT_FILE = join(homedir(), 'Library', 'Application Support', 'corner', 'cli-port')
const TOKEN_FILE = join(homedir(), 'Library', 'Application Support', 'corner', 'cli-token')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getPort() {
  try {
    return parseInt(readFileSync(PORT_FILE, 'utf8').trim(), 10) || null
  } catch {
    return null
  }
}

function getToken() {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim() || null
  } catch {
    return null
  }
}

function openApp() {
  try {
    execSync('open -a corner', { stdio: 'ignore', timeout: 5000 })
  } catch {
    // app may not be installed — will be caught by waitForPort
  }
}

async function ensurePort() {
  let port = getPort()
  if (port) return port

  openApp()
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    port = getPort()
    if (port) return port
  }
  throw new Error('corner app did not start in time (check if corner.app is installed)')
}

async function request(path, method = 'GET', body = null) {
  const port = await ensurePort()
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const options = { method, headers }
  if (body) options.body = JSON.stringify(body)

  const res = await fetch(`http://127.0.0.1:${port}${path}`, options)
  const data = await res.json()
  if (!res.ok) {
    const msg = data.error || `HTTP ${res.status}`
    throw new Error(msg)
  }
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
    return `▶ Playing playlist (${data.trackCount} tracks)`
  }

  // status with playback info
  if (data.ok !== undefined && data.running) {
    const pb = data.playback
    if (!pb) return 'corner is running (no playback info)'

    const playIcon = pb.isPlaying ? '▶' : '⏸'
    const lines = [`corner is running`]

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

const HELP = `corner CLI — remote control for the corner music player

Usage:
  corner help                             show this help
  corner status                           show playback status
  corner toggle                           toggle play/pause
  corner next                             next track
  corner prev                             previous track
  corner shuffle                          toggle shuffle
  corner repeat                           cycle repeat mode (off → all → one)
  corner volume <0..1>                    set volume
  corner seek <sec> | +<sec> | -<sec>     seek absolute / relative
  corner playlists                        list playlists
  corner playlist create <name>           create a playlist
  corner playlist rename <id> <name>      rename a playlist
  corner playlist delete <id>             delete a playlist
  corner playlist tracks <id>             list playlist tracks
  corner playlist add <id> <trackId>      add a track to a playlist
  corner playlist remove <id> <trackId>   remove a track from a playlist
  corner sources                          list sources
  corner libraries                        list imported music libraries
  corner library update <rootPath>        re-sync/update a specific music library
  corner search <query>                   search tracks
  corner play --playlist-id <id>          play a playlist
  corner play --track-id <id>             play a single track
  corner play --query <query>             search & play first match
  corner favorites                        list favorite tracks
  corner favorite <trackId>               add to favorites
  corner unfavorite <trackId>             remove from favorites
  corner history [limit]                  show recently played tracks
  corner download <trackId> [--out <path>] download track audio to local disk
  corner song-info --prompt <text>        query and save song intro/lyrics
  corner song-info --get <id|path|title>  read saved song metadata
  corner events                           stream playback events (SSE)

Add --json or -j to any command for JSON output.`

async function streamEvents() {
  const port = await ensurePort()
  const headers = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${port}/events`, { headers })
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
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.log(HELP)
    process.exit(0)
  }

  const cmd = args[0]
  const rest = args.slice(1)
  const useJson = rest.some(isJsonFlag)
  const flags = positional(rest)

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

        if (playlistIdx >= 0 && playlistIdx + 1 < args.length) {
          const data = await request('/play', 'POST', { playlistId: args[playlistIdx + 1] })
          print(data, useJson)
        } else if (trackIdx >= 0 && trackIdx + 1 < args.length) {
          const data = await request('/play', 'POST', { trackId: args[trackIdx + 1] })
          print(data, useJson)
        } else if (queryIdx >= 0 && queryIdx + 1 < args.length) {
          const data = await request('/play', 'POST', { query: args[queryIdx + 1] })
          print(data, useJson)
        } else {
          console.error('Usage: corner play --playlist-id <id> | --track-id <id> | --query <query>')
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
        if (args.includes('--help') || args.includes('-h')) {
          console.log('Usage: corner song-info --prompt "<song and path>" [--model <model>] [--json] | --get <id|path|title> [--json]')
          break
        }
        const promptIdx = args.indexOf('--prompt')
        const modelIdx = args.indexOf('--model')
        const getIdx = args.indexOf('--get')
        if (getIdx >= 0 && getIdx + 1 < args.length) {
          const identifier = args[getIdx + 1]
          const data = await request(`/api/music/song-info?path=${encodeURIComponent(identifier)}`)
          print(data, useJson)
        } else if (promptIdx >= 0 && promptIdx + 1 < args.length) {
          const prompt = args[promptIdx + 1]
          const modelId = modelIdx >= 0 && modelIdx + 1 < args.length ? args[modelIdx + 1] : undefined
          const data = await request('/api/music/song-info', 'POST', { prompt, model: modelId })
          print(data, useJson)
        } else {
          console.error('Usage: corner song-info --prompt "<song and path>" [--model qwen/qwen3.7-plus] | --get <id|path|title>')
          process.exit(1)
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
