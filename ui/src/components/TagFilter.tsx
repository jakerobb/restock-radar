import { useState } from 'react'
import { cn } from '../lib/cn'
import { groupTags, type TagCount } from '../lib/filter'
import { TagGroup } from './TagGroup'
import { TextInput } from './ui/TextInput'

interface TagFilterProps {
  tags: TagCount[]
  /** For each tag prefix, how many of the products currently shown carry one of its tags. */
  groupTotals: Map<string, number>
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
 * Tags written `prefix:name` are grouped behind one chip per prefix that pops up checkboxes.
 * Chips combine: choosing several narrows to products that have all of them.
 * The list can be long, so it collapses (chosen tags stay visible) and can be searched.
 */
export function TagFilter({ tags, groupTotals, selected, onToggle, onClear }: TagFilterProps) {
  const [open, setOpen] = useState(tags.length <= OPEN_BY_DEFAULT)
  const [search, setSearch] = useState('')
  if (tags.length === 0) return null

  const needle = search.trim().toLowerCase()
  const matching = open ? tags.filter((t) => !needle || t.tag.toLowerCase().includes(needle)) : tags
  const { plain, groups } = groupTags(matching)
  // Collapsed, only what's chosen stays visible: plain chips, and the groups holding a chosen option.
  const visible = open ? plain : plain.filter((t) => selected.includes(t.tag))
  const visibleGroups = open ? groups : groups.filter((g) => g.options.some((o) => selected.includes(o.tag)))

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
        {visibleGroups.map((g) => (
          <TagGroup key={g.prefix} prefix={g.prefix} options={g.options} total={groupTotals.get(g.prefix) ?? 0} selected={selected} onToggle={onToggle} />
        ))}
        {open && visible.length === 0 && visibleGroups.length === 0 && <p className="text-sm text-muted">No tags match “{search}”.</p>}
      </div>
    </div>
  )
}
