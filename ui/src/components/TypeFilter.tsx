import { cn } from '../lib/cn'
import type { TypeCount } from '../lib/filter'

interface TypeFilterProps {
  types: TypeCount[]
  /** The chosen type; empty means all. */
  selected: string
  total: number
  onChange: (type: string) => void
}

/** Underlined tabs narrowing the list to one product type; they scroll sideways when there are too many to fit. */
export function TypeFilter({ types, selected, total, onChange }: TypeFilterProps) {
  if (types.length < 2) return null
  const tab = (type: string, label: string, count: number) => {
    const active = selected === type
    return (
      <button
        key={type || 'all'}
        type="button"
        aria-pressed={active}
        onClick={() => onChange(active ? '' : type)}
        className={cn(
          '-mb-px shrink-0 cursor-pointer whitespace-nowrap border-b-2 px-0.5 pt-1 pb-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          active ? 'border-accent font-semibold text-ink' : 'border-transparent text-muted hover:border-line hover:text-ink',
          count === 0 && !active && 'opacity-50',
        )}
      >
        {label} <span className={active ? 'text-muted' : 'opacity-80'}>{count}</span>
      </button>
    )
  }
  return (
    <div className="mt-3 mb-4 flex gap-5 overflow-x-auto border-b border-line [scrollbar-width:thin]" role="group" aria-label="Filter by product type">
      {tab('', 'All', total)}
      {types.map((t) => tab(t.type, t.type, t.count))}
    </div>
  )
}
