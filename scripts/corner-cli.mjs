#!/usr/bin/env node
/**
 * corner CLI — remote control for the corner music player.
 *
 * Usage:
 *   corner playlists                          list playlists
 *   corner search <query>                     search tracks
 *   corner play --playlist-id <id>            play a playlist
 *   corner play --track-id <id>               play a single track
 *   corner play --query <query>               search & play first match
 *   corner toggle                             toggle play/pause
 *   corner next                               next track
 *   corner prev                               previous track
 *   corner status                             check if running
 *
 * JSON output: add --json to any command.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

const PORT_FILE = join(homedir(), 'Library', 'Application Support', 'corner', 'cli-port')

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
  const options = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {}
  }
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

function print(data, useJson) {
  if (useJson) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(formatHuman(data))
  }
}

function formatHuman(data) {
  if (!data) return ''

  // playlist list
  if (Array.isArray(data) && data[0]?.name !== undefined && data[0]?.trackCount !== undefined) {
    return data.map((p, i) => `${i + 1}. ${p.name} (${p.trackCount} tracks, id: ${p.id})`).join('\n')
  }

  // source list
  if (Array.isArray(data) && data[0]?.type !== undefined) {
    return data.map((s, i) => `${i + 1}. ${s.name} [${s.type}] (id: ${s.id})`).join('\n')
  }

  // search results
  if (data.tracks && Array.isArray(data.tracks)) {
    if (data.tracks.length === 0) return 'No tracks found.'
    return data.tracks.map((t, i) =>
      `${i + 1}. ${t.title} — ${t.artist || 'unknown'} [${t.sourceId}] (id: ${t.id})`
    ).join('\n')
  }

  // play result
  if (data.track) {
    return `▶ ${data.track.title} — ${data.track.artist || 'unknown'} [${data.track.sourceId}]`
  }
  if (data.trackCount !== undefined) {
    return `▶ Playing playlist (${data.trackCount} tracks)`
  }

  // status
  if (data.ok !== undefined && data.running) return 'corner is running'

  // fallback
  if (data.ok !== undefined && data.error) return `Error: ${data.error}`
  return JSON.stringify(data, null, 2)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.log('Usage: corner <command> [options]')
    console.log('Commands: sources, playlists, search, play, toggle, next, prev, status')
    console.log('Add --json for JSON output.')
    process.exit(1)
  }

  const cmd = args[0]
  const rest = args.slice(1)
  const useJson = rest.some(isJsonFlag)
  const flags = rest.filter(a => !a.startsWith('-'))

  try {
    switch (cmd) {
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
      case 'status': {
        const data = await request('/status')
        print(data, useJson)
        break
      }
      default:
        console.error(`Unknown command: ${cmd}`)
        console.error('Available: sources, playlists, search, play, toggle, next, prev, status')
        process.exit(1)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

main()
