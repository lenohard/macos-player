import type {
  IPCApi,
  MusicBrainzLookupResult,
  PlaylistSummary,
  SongInfoMeta,
  SongInfoTask,
  Track,
  TrackDetail,
  TrackIdentification,
  TracksPage
} from '@shared/ipc'

export type WebPlaylistSummary = PlaylistSummary & { builtin?: boolean }

export type TrackIdentificationResult = MusicBrainzLookupResult

export type CornerWebApi = Pick<IPCApi,
  | 'listTracksPage'
  | 'trackGetDetail'
  | 'playlistListTracks'
  | 'playlistAddTrack'
  | 'favoritesList'
  | 'favoritesAdd'
  | 'favoritesRemove'
  | 'songInfoGet'
  | 'songInfoLookup'
  | 'songInfoListTasks'
  | 'songInfoGetTaskResult'
  | 'songInfoCancelTask'
  | 'songInfoRetryTask'
  | 'songInfoDeleteTask'
  | 'musicBrainzLookup'
  | 'trackApplyIdentification'
> & {
  playlistList(): Promise<WebPlaylistSummary[]>
  playlistCreate(name: string): Promise<WebPlaylistSummary>
  listRandomTracks(count: number): Promise<TracksPage>
  trackUpdate(id: string, title: string, artist: string | null): Promise<Track>
  trackDelete(id: string): Promise<{ ok: true }>
  trackIdentify(id: string): Promise<TrackIdentificationResult>
}

type ConnectionListener = (reachable: boolean) => void

function audioUrl(id: string): string {
  return `./api/tracks/${encodeURIComponent(id)}/audio`
}

function withAudio<T extends Track>(track: T): T {
  return { ...track, playbackUrl: audioUrl(track.id) }
}

export function createCornerWebApi(onConnection: ConnectionListener): CornerWebApi {
  async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetch(path, { ...init, cache: 'no-store' })
    } catch (error) {
      onConnection(false)
      throw error
    }
    onConnection(![502, 503, 504].includes(response.status))
    return response
  }

  async function decode<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || `请求失败（${response.status}）`)
    }
    return await response.json() as T
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    return decode<T>(await fetchApi(path, init))
  }

  async function optional<T>(path: string): Promise<T | null> {
    const response = await fetchApi(path)
    if (response.status === 404) return null
    return decode<T>(response)
  }

  function mutation(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: object = {}): RequestInit {
    return {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  }

  return {
    async listTracksPage(sourceId, offset, limit, search = '', identified = 'all') {
      const params = new URLSearchParams({
        sourceId,
        offset: String(offset),
        limit: String(limit),
        q: search,
        identified
      })
      const page = await request<TracksPage>(`./api/tracks?${params}`)
      return { ...page, tracks: page.tracks.map(withAudio) }
    },

    async trackGetDetail(id) {
      const track = await optional<TrackDetail>(`./api/tracks/${encodeURIComponent(id)}`)
      return track ? withAudio(track) : null
    },

    async trackUpdate(id, title, artist) {
      const track = await request<Track>(
        `./api/tracks/${encodeURIComponent(id)}`,
        mutation('PATCH', { title, artist })
      )
      return withAudio(track)
    },

    async trackDelete(id) {
      return request<{ ok: true }>(
        `./api/tracks/${encodeURIComponent(id)}`,
        mutation('DELETE')
      )
    },

    async trackIdentify(id) {
      return request<TrackIdentificationResult>(`./api/tracks/${encodeURIComponent(id)}/identify`)
    },

    async musicBrainzLookup(trackId) {
      return request<MusicBrainzLookupResult>(`./api/tracks/${encodeURIComponent(trackId)}/identify`)
    },

    async trackApplyIdentification(trackId, identification: TrackIdentification) {
      const track = await request<TrackDetail>(
        `./api/tracks/${encodeURIComponent(trackId)}`,
        mutation('PATCH', { identification })
      )
      return withAudio(track)
    },

    async playlistList() {
      return request<WebPlaylistSummary[]>('./api/playlists')
    },

    async playlistCreate(name) {
      return request<WebPlaylistSummary>('./api/playlists', mutation('POST', { name }))
    },

    async listRandomTracks(count) {
      const page = await request<TracksPage>(`./api/tracks?sourceId=all&random=${count}`)
      return { ...page, tracks: page.tracks.map(withAudio) }
    },

    async playlistListTracks(playlistId) {
      const result = await request<{ tracks: Track[] }>(
        `./api/playlists/${encodeURIComponent(playlistId)}/tracks`
      )
      return result.tracks.map(withAudio)
    },

    async playlistAddTrack(playlistId, trackId) {
      await request<{ ok: true }>(
        `./api/playlists/${encodeURIComponent(playlistId)}/tracks`,
        mutation('POST', { trackId })
      )
    },

    async favoritesList() {
      const result = await request<{ tracks: Track[] }>('./api/favorites')
      return result.tracks.map(withAudio)
    },

    async favoritesAdd(track) {
      const id = typeof track === 'string' ? track : track.id
      await request<{ ok: true }>(`./api/favorites/${encodeURIComponent(id)}`, mutation('PUT'))
    },

    async favoritesRemove(trackId) {
      await request<{ ok: true }>(`./api/favorites/${encodeURIComponent(trackId)}`, mutation('DELETE'))
    },

    async songInfoGet(identifier) {
      return optional<SongInfoMeta>(`./api/song-info?identifier=${encodeURIComponent(identifier)}`)
    },

    async songInfoLookup(trackId) {
      return request<{ requestId: string }>('./api/song-info/tasks', mutation('POST', { trackId }))
    },

    async songInfoListTasks() {
      const result = await request<{ tasks: SongInfoTask[] }>('./api/song-info/tasks')
      return result.tasks
    },

    async songInfoGetTaskResult(id) {
      return optional<SongInfoMeta>(`./api/song-info/tasks/${encodeURIComponent(id)}/result`)
    },

    async songInfoCancelTask(id) {
      await request<{ ok: true }>(
        `./api/song-info/tasks/${encodeURIComponent(id)}/cancel`, mutation('POST')
      )
    },

    async songInfoRetryTask(id) {
      return request<{ requestId: string }>(
        `./api/song-info/tasks/${encodeURIComponent(id)}/retry`, mutation('POST')
      )
    },

    async songInfoDeleteTask(id) {
      await request<{ ok: true }>(`./api/song-info/tasks/${encodeURIComponent(id)}`, mutation('DELETE'))
    }
  }
}
