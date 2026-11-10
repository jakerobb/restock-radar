import { cn } from '../lib/cn'
import type { TypeCount } from '../lib/filter'

interface TypeFilterProps {
  types: TypeCount[]
  /** The chosen type; empty means all. */
  selected: string
  total: number
  onChange: (type: string) => void
}

/** Chips narrowing the list to one product type. */
export function TypeFilter({ types, selected, total, onChange }: TypeFilterProps) {
  if (types.length < 2) return null
  const chip = (type: string, label: string, count: number) => {
    const active = selected === type
    return (
      <button
        key={type || 'all'}
        type="button"
        aria-pressed={active}
        onClick={() => onChange(active ? '' : type)}
        className={cn(
          'cursor-pointer rounded-full border px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          active ? 'border-accent bg-accent text-on-accent' : 'border-line bg-surface text-ink hover:border-accent',
        )}
      >
        {label} <span className={active ? 'opacity-80' : 'text-muted'}>{count}</span>
      </button>
    )
  }
  return (
    <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by product type">
      {chip('', 'All', total)}
      {types.map((t) => chip(t.type, t.type, t.count))}
    </div>
  )
}
