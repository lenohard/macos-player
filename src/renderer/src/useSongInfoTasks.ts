import { useCallback, useEffect, useState } from 'react'
import type { IPCApi, SongInfoTask } from '@shared/ipc'

type SongInfoTasksApi = Pick<IPCApi, 'songInfoListTasks'> &
  Partial<Pick<IPCApi, 'onSongInfoTasksChanged'>>

export default function useSongInfoTasks(api: SongInfoTasksApi = window.api) {
  const [tasks, setTasks] = useState<SongInfoTask[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = useCallback(() => {
    setLoading(true)
    setRefreshKey(key => key + 1)
  }, [])

  useEffect(() => {
    let active = true
    let inFlight = false
    let timer: number | undefined
    let requestedDelay: number | null = null
    let nextPollDelay = 15000
    const hasPushUpdates = api.onSongInfoTasksChanged !== undefined

    function schedule(delay = 120) {
      if (!active || (!hasPushUpdates && document.visibilityState !== 'visible')) return
      if (inFlight) {
        requestedDelay = requestedDelay === null ? delay : Math.min(requestedDelay, delay)
        return
      }
      if (timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        void update()
      }, delay)
    }

    async function update() {
      if (inFlight || !active) return
      inFlight = true
      try {
        const next = await api.songInfoListTasks()
        nextPollDelay = next.some(task => task.status === 'running') ? 3000 : 15000
        if (active) {
          setTasks(next)
          setLoadError(false)
        }
      } catch {
        nextPollDelay = 15000
        if (active) setLoadError(true)
      } finally {
        inFlight = false
        if (active) {
          setLoading(false)
          if (requestedDelay !== null) {
            const delay = requestedDelay
            requestedDelay = null
            schedule(delay)
          } else if (!hasPushUpdates) {
            schedule(nextPollDelay)
          }
        }
      }
    }

    function refreshVisible() {
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
      if (document.visibilityState === 'visible') schedule(0)
    }

    const unsubscribe = api.onSongInfoTasksChanged?.(() => schedule()) ?? (() => {})
    if (!hasPushUpdates) {
      window.addEventListener('focus', refreshVisible)
      document.addEventListener('visibilitychange', refreshVisible)
    }
    void update()
    return () => {
      active = false
      unsubscribe()
      if (!hasPushUpdates) {
        window.removeEventListener('focus', refreshVisible)
        document.removeEventListener('visibilitychange', refreshVisible)
      }
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [api, refreshKey])

  return { tasks, loading, loadError, refresh }
}
