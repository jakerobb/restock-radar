import { useNow } from '../hooks/useNow'
import { formatExact, formatRelative } from '../lib/format'

/** A timestamp shown relative to now, with the exact time as a tooltip. */
export function RelativeTime({ iso }: { iso: string }) {
  const now = useNow()
  return (
    <time dateTime={iso} title={formatExact(iso)}>
      {formatRelative(iso, now)}
    </time>
  )
}
