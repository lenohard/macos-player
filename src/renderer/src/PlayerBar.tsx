import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { PlaylistSummary, Track } from '@shared/ipc'

export interface PlayerBarHandle {
  /** Start a selected track synchronously in the user's click handler (iOS Safari). */
  play(track: Track): void
  /** Desktop CLI transport command: toggle play/pause. */
  togglePlay(): void
  /** Desktop CLI transport command: set output volume (0..1). */
  setVolume(value: number): void
  /** Desktop CLI transport command: seek to an absolute position (seconds). */
  seek(positionSec: number): void
}

interface PlayerBarProps {
  tracks: Track[]
  currentIndex: number
  currentTrack?: Track
  playbackRequest: number
  temporaryTrack: boolean
  shuffle: boolean
  repeatMode: 'off' | 'all' | 'one'
  playlists: PlaylistSummary[]
  onPlayingChange(playing: boolean): void
  onVolumeChange(volume: number): void
  onPositionChange(positionSec: number, durationSec: number): void
  onShuffleChange(shuffle: boolean): void
  onRepeatChange(): void
  onTemporaryEnded(): void
  onNext(): void
  onPrevious(): void
  onAddToPlaylist(playlistId: string): void
  isFavorite: boolean
  onToggleFavorite(): void
  onOpenDetail(): void
}

// 文本类输入框（搜索、歌单命名等）里不应被空格劫持；range 滑杆等控件除外
function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['range', 'checkbox', 'radio'].includes(type)
  }
  return false
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

const PlayerBar = forwardRef<PlayerBarHandle, PlayerBarProps>(function PlayerBar({
  tracks,
  currentIndex,
  currentTrack,
  playbackRequest,
  temporaryTrack,
  shuffle,
  repeatMode,
  playlists,
  onPlayingChange,
  onVolumeChange,
  onPositionChange,
  onShuffleChange,
  onRepeatChange,
  onTemporaryEnded,
  onNext,
  onPrevious,
  onAddToPlaylist,
  isFavorite,
  onToggleFavorite,
  onOpenDetail
}: PlayerBarProps, ref) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const explicitTrackRef = useRef<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [showPlaylistMenu, setShowPlaylistMenu] = useState(false)

  useImperativeHandle(ref, () => ({
    play(track) {
      const audio = audioRef.current
      if (!audio) return
      explicitTrackRef.current = track.id
      setPlaybackError(null)
      setCurrentTime(0)
      setDuration(0)
      audio.src = track.playbackUrl
      audio.load()
      void audio.play().catch(() => {
        setIsPlaying(false)
        setPlaybackError('无法播放此文件')
      })
    },
    // toggleRef 每次渲染指向最新的 togglePlayback；handle 只在 layout 阶段创建一次。
    togglePlay() {
      void toggleRef.current()
    },
    setVolume(value) {
      setVolume(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)))
    },
    seek(positionSec) {
      const audio = audioRef.current
      if (!audio || !Number.isFinite(positionSec)) return
      const target = Math.max(0, positionSec)
      audio.currentTime = target
      setCurrentTime(target)
    }
  }), [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    if (!currentTrack) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      setIsPlaying(false)
      setCurrentTime(0)
      setDuration(0)
      return
    }

    const explicitlyStarted = explicitTrackRef.current === currentTrack.id
    explicitTrackRef.current = null
    setPlaybackError(null)
    if (!explicitlyStarted) {
      setCurrentTime(0)
      setDuration(0)
      audio.src = currentTrack.playbackUrl
      audio.load()
    }
    if (playbackRequest > 0 && audio.paused) {
      void audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false))
    }
  }, [currentTrack, playbackRequest])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
    onVolumeChange(volume)
  }, [volume, onVolumeChange])

  const toggleRef = useRef(togglePlayback)
  toggleRef.current = togglePlayback

  // 窗口在前台时，空格键全局切换播放/暂停（输入框内不劫持）
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.code !== 'Space' || event.repeat) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTextInput(event.target) || (event.target instanceof HTMLElement &&
          event.target.closest('dialog, button, a[href], summary, [role="button"], [role="tab"]'))) return
      event.preventDefault()
      event.stopPropagation()
      void toggleRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  async function togglePlayback(): Promise<void> {
    const audio = audioRef.current
    if (!audio || !currentTrack) return

    if (audio.paused) {
      setPlaybackError(null)
      try {
        await audio.play()
        setIsPlaying(true)
      } catch {
        setPlaybackError('无法播放此文件')
      }
    } else {
      audio.pause()
      setIsPlaying(false)
    }
  }

  function handlePrevious(): void {
    const audio = audioRef.current
    if (!audio || currentIndex < 0) return
    if (audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    onPrevious()
  }

  function handleEnded(): void {
    if (!currentTrack) return
    if (repeatMode === 'one') {
      const audio = audioRef.current
      if (audio) {
        audio.currentTime = 0
        void audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false))
      }
      return
    }
    if (temporaryTrack) {
      setIsPlaying(false)
      onTemporaryEnded()
      return
    }
    if (repeatMode === 'all' || shuffle || currentIndex < tracks.length - 1) {
      if (tracks.length <= 1 && repeatMode === 'all') {
        const audio = audioRef.current
        if (audio) {
          audio.currentTime = 0
          void audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false))
        }
      } else {
        onNext()
      }
      return
    }
    setIsPlaying(false)
  }

  function seek(value: number): void {
    if (!audioRef.current) return
    audioRef.current.currentTime = value
    setCurrentTime(value)
  }

  const canGoNext = tracks.length > 0 && currentIndex >= 0
  const canGoPrevious = tracks.length > 0 && currentIndex >= 0

  return (
    <footer className="player-bar">
      <audio
        ref={audioRef}
        preload="metadata"
        onLoadedMetadata={event => {
          setDuration(event.currentTarget.duration)
          onPositionChange(event.currentTarget.currentTime, event.currentTarget.duration)
        }}
        onDurationChange={event => {
          setDuration(event.currentTarget.duration)
          onPositionChange(event.currentTarget.currentTime, event.currentTarget.duration)
        }}
        onTimeUpdate={event => {
          setCurrentTime(event.currentTarget.currentTime)
          onPositionChange(event.currentTarget.currentTime, event.currentTarget.duration)
        }}
        onPlay={() => { setIsPlaying(true); onPlayingChange(true) }}
        onPause={() => { setIsPlaying(false); onPlayingChange(false) }}
        onEnded={handleEnded}
        onError={() => setPlaybackError('无法播放此文件')}
      />

      <div
        className="now-playing"
        role="button"
        tabIndex={0}
        aria-label="查看详情"
        title="查看详情"
        onClick={onOpenDetail}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpenDetail()
          }
        }}
      >
        <div className="cover-placeholder" aria-hidden="true">♪</div>
        <div className="now-playing-text">
          <strong>{currentTrack?.title ?? '未在播放'}</strong>
          <span>{playbackError ?? currentTrack?.artist ?? (currentTrack ? '云盘音乐' : '选择音乐开始播放')}</span>
        </div>
      </div>

      <div className="transport">
        <div className="transport-buttons">
          <button
            className={`icon-button ${shuffle ? 'active-toggle' : ''}`}
            onClick={() => onShuffleChange(!shuffle)}
            disabled={tracks.length < 2}
            aria-label="随机播放"
            title="随机播放"
          >
            ⤮
          </button>
          <button
            className={`icon-button ${repeatMode !== 'off' ? 'active-toggle' : ''}`}
            onClick={onRepeatChange}
            disabled={!currentTrack}
            aria-label="循环模式"
            title={repeatMode === 'off' ? '不循环' : repeatMode === 'all' ? '列表循环' : '单曲循环'}
          >
            {repeatMode === 'one' ? '1' : '↻'}
          </button>
          <button
            className="icon-button"
            onClick={handlePrevious}
            disabled={!canGoPrevious}
            aria-label="上一首"
            title="上一首"
          >
            ‹
          </button>
          <button
            className="play-button"
            onClick={() => void togglePlayback()}
            disabled={!currentTrack}
            aria-label={isPlaying ? '暂停' : '播放'}
            title={isPlaying ? '暂停' : '播放'}
          >
            {isPlaying ? 'Ⅱ' : '▶'}
          </button>
          <button
            className="icon-button"
            onClick={onNext}
            disabled={!canGoNext}
            aria-label="下一首"
            title="下一首"
          >
            ›
          </button>
          <button
            className={`icon-button favorite-button ${isFavorite ? 'active-toggle' : ''}`}
            onClick={onToggleFavorite}
            disabled={!currentTrack}
            aria-label={isFavorite ? '取消收藏' : '收藏'}
            title={isFavorite ? '取消收藏' : '收藏'}
          >
            {isFavorite ? '♥' : '♡'}
          </button>
          <div className="add-to-playlist">
            <button
              className="icon-button"
              disabled={!currentTrack}
              aria-label="添加到歌单"
              title="添加到歌单"
              onClick={() => setShowPlaylistMenu(open => !open)}
            >
              ＋
            </button>
            {showPlaylistMenu && currentTrack && (
              <div className="playlist-menu" role="menu">
                {playlists.length === 0 && <span className="menu-empty">暂无歌单</span>}
                {playlists.map(playlist => (
                  <button
                    key={playlist.id}
                    role="menuitem"
                    onClick={() => {
                      onAddToPlaylist(playlist.id)
                      setShowPlaylistMenu(false)
                    }}
                  >
                    {playlist.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="progress-row">
          <span>{formatTime(currentTime)}</span>
          <input
            className="progress-slider"
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={0.1}
            value={Math.min(currentTime, Math.max(duration, 1))}
            onChange={event => seek(Number(event.target.value))}
            disabled={!currentTrack || duration === 0}
            aria-label="播放进度"
          />
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="volume-control">
        <span aria-hidden="true">音量</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={event => setVolume(Number(event.target.value))}
          aria-label="音量"
        />
      </div>
    </footer>
  )
})

export default PlayerBar
