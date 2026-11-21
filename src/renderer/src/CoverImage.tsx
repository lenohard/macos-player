import { useState } from 'react'

interface CoverImageProps {
  src?: string | null
  className: string
  fallbackClassName?: string
  alt?: string
  loading?: 'lazy' | 'eager'
}

export default function CoverImage({ src, className, fallbackClassName, alt = '', loading }: CoverImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!src || failedSrc === src) {
    return <span className={fallbackClassName ? `${className} ${fallbackClassName}` : className} aria-hidden="true">♪</span>
  }
  return <img className={className} src={src} alt={alt} loading={loading} referrerPolicy="no-referrer"
    onError={() => setFailedSrc(src)} />
}
