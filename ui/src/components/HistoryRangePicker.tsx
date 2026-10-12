import { HISTORY_RANGES } from '../lib/historyRange'
import { cn } from '../lib/cn'

interface HistoryRangePickerProps {
  days: number
  onChange: (days: number) => void
}

/** A row of toggle buttons choosing how many days of history the charts show. */
export function HistoryRangePicker({ days, onChange }: HistoryRangePickerProps) {
  return (
    <div role="group" aria-label="History range" className="flex items-center gap-2 text-sm">
      <span className="text-muted">History:</span>
      <div className="inline-flex overflow-hidden rounded-lg border border-line">
        {HISTORY_RANGES.map((range) => (
          <button
            key={range}
            type="button"
            aria-pressed={range === days}
            onClick={() => onChange(range)}
            className={cn(
              'cursor-pointer border-l border-line px-3 py-1 first:border-l-0',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
              range === days ? 'bg-accent font-medium text-on-accent' : 'bg-surface text-ink hover:bg-canvas',
            )}
          >
            {range === 365 ? '1 year' : `${range} days`}
          </button>
        ))}
      </div>
    </div>
  )
}
