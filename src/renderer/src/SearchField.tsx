import { useEffect, useRef } from 'react'

type SearchFieldProps = {
  value: string
  onChange: (value: string) => void
  placeholder: string
  'aria-label': string
  disabled?: boolean
  /** Fire after user stops typing (ms). Omit to only update local value. */
  debounceMs?: number
  onDebouncedChange?: (value: string) => void
}

export default function SearchField({
  value,
  onChange,
  placeholder,
  'aria-label': ariaLabel,
  disabled,
  debounceMs,
  onDebouncedChange
}: SearchFieldProps): JSX.Element {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipInitialDebounceRef = useRef(true)

  useEffect(() => {
    if (!onDebouncedChange || debounceMs === undefined) return
    if (skipInitialDebounceRef.current) {
      skipInitialDebounceRef.current = false
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      onDebouncedChange(value)
    }, debounceMs)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [value, debounceMs, onDebouncedChange])

  return (
    <label className="search-field">
      <span className="search-field-icon" aria-hidden="true">
        ⌕
      </span>
      <input
        type="search"
        enterKeyHint="search"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={event => onChange(event.target.value)}
      />
      {value.length > 0 && (
        <button
          type="button"
          className="search-field-clear"
          aria-label="清除搜索"
          disabled={disabled}
          onClick={() => onChange('')}
        >
          ×
        </button>
      )}
    </label>
  )
}
