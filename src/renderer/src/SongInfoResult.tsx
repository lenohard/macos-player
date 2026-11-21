import type { SongInfoMeta, SongLyricsLine } from '@shared/ipc'
import './ai-search-center.css'

function lyricLines(meta: SongInfoMeta): SongLyricsLine[] {
  if (meta.lyricsBilingual.length > 0) return meta.lyricsBilingual
  return Array.isArray(meta.lyrics) ? meta.lyrics : []
}

export default function SongInfoResult({ meta }: { meta: SongInfoMeta }) {
  if (!meta.found) {
    return (
      <div className="song-info-result song-info-result-missing">
        <span className="song-info-result-missing-icon" aria-hidden="true">♪</span>
        <h3>没有找到可靠的歌曲信息</h3>
        <p>{meta.reason || '可以稍后重试，或调整检索设置后再次搜索。'}</p>
      </div>
    )
  }

  const lines = lyricLines(meta)
  const plainLyrics = typeof meta.lyrics === 'string' ? meta.lyrics : ''
  const hasContent = Boolean(meta.intro || lines.length > 0 || plainLyrics)

  return (
    <article className="song-info-result">
      {meta.intro && <p className="song-info-result-intro">{meta.intro}</p>}

      {lines.length > 0 && (
        <section className="song-info-result-section" aria-label="歌词">
          <h3>歌词</h3>
          <div className="song-info-result-lyrics bilingual">
            {lines.map((line, index) => (
              <p className="song-info-result-lyric-line" key={`${index}-${line.original}`}>
                <span>{line.original}</span>
                {line.translated && <span className="translated">{line.translated}</span>}
              </p>
            ))}
          </div>
        </section>
      )}

      {lines.length === 0 && plainLyrics && (
        <section className="song-info-result-section" aria-label="歌词">
          <h3>歌词</h3>
          <pre className="song-info-result-lyrics">{plainLyrics}</pre>
        </section>
      )}

      {!hasContent && (
        <p className="song-info-result-empty">这次检索已完成，但没有可展示的歌曲介绍或歌词。</p>
      )}

      <footer className="song-info-result-footer">
        <span>{meta.model}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={new Date(meta.updatedAt).toISOString()}>
          {new Date(meta.updatedAt).toLocaleString('zh-CN', { hour12: false })}
        </time>
        {meta.source && <span className="song-info-result-source">来源 {meta.source}</span>}
      </footer>
    </article>
  )
}
