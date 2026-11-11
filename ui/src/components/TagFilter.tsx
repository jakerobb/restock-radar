import { useState } from 'react'
import { cn } from '../lib/cn'
import type { TagCount } from '../lib/filter'
import { TextInput } from './ui/TextInput'

interface TagFilterProps {
  tags: TagCount[]
  /** The chosen tags; a product must carry all of them. */
  selected: string[]
  onToggle: (tag: string) => void
  onClear: () => void
}

/** Up to this many tags the list starts open; beyond it, it starts collapsed. */
const OPEN_BY_DEFAULT = 20
/** From this many tags on, the list gets its own search box. */
const SEARCHABLE = 12

/**
 * One chip per tag the store puts on any product (black-friday, feature:4k, ...).
 * Chips combine: choosing several narrows to products that have all of them.
 * The list can be long, so it collapses (chosen tags stay visible) and can be searched.
 */
export function TagFilter({ tags, selected, onToggle, onClear }: TagFilterProps) {
  const [open, setOpen] = useState(tags.length <= OPEN_BY_DEFAULT)
  const [search, setSearch] = useState('')
  if (tags.length === 0) return null

  const needle = search.trim().toLowerCase()
  const visible = open ? tags.filter((t) => !needle || t.tag.toLowerCase().includes(needle)) : tags.filter((t) => selected.includes(t.tag))

  return (
    <div className="mb-4" role="group" aria-label="Filter by tag">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {open ? '▾' : '▸'} Tags <span className="text-muted">{tags.length}</span>
        </button>
        {selected.length > 0 && (
          <button type="button" onClick={onClear} className="cursor-pointer text-muted underline hover:text-ink">
            Clear {selected.length === 1 ? 'tag' : `${selected.length} tags`}
          </button>
        )}
        {open && tags.length >= SEARCHABLE && (
          <TextInput
            type="search"
            className="min-w-0 max-w-56 flex-1 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tags"
            aria-label="Search tags"
            autoComplete="off"
          />
        )}
      </div>
      <div className={cn('flex flex-wrap gap-2', open && 'max-h-44 overflow-y-auto')}>
        {visible.map(({ tag, count }) => {
          const active = selected.includes(tag)
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(tag)}
              className={cn(
                'cursor-pointer rounded-full border px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                active ? 'border-accent bg-accent text-on-accent' : 'border-line bg-surface text-ink hover:border-accent',
                count === 0 && !active && 'opacity-50',
              )}
            >
              {tag} <span className={active ? 'opacity-80' : 'text-muted'}>{count}</span>
            </button>
          )
        })}
        {open && visible.length === 0 && <p className="text-sm text-muted">No tags match “{search}”.</p>}
      </div>
    </div>
  )
}
