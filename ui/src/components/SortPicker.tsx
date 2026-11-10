import { SORT_OPTIONS, isSortKey, type SortKey } from '../lib/sort'

interface SortPickerProps {
  sort: SortKey
  onChange: (sort: SortKey) => void
}

/** A dropdown choosing how the product list is ordered. */
export function SortPicker({ sort, onChange }: SortPickerProps) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">Sort:</span>
      <select
        value={sort}
        onChange={(e) => isSortKey(e.target.value) && onChange(e.target.value)}
        className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-1 text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
