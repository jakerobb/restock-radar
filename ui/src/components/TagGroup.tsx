import { useCallback, useMemo, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import type { TagGroupCounts } from '../lib/filter'

interface TagGroupProps extends TagGroupCounts {
  /** How many of the products currently shown carry any tag of this prefix. */
  total: number
  selected: string[]
  onToggle: (tag: string) => void
}

const POPOVER_WIDTH = 256

/**
 * One chip for a family of `prefix:name` tags (feature:4k, feature:poe, ...).
 * Clicking it pops up the options, each with a checkbox; chosen options combine like any other tags.
 */
export function TagGroup({ prefix, options: unsorted, total, selected, onToggle }: TagGroupProps) {
  // Fixed positioning lets the popup escape the scrolling containers around the chips.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const open = pos !== null
  const close = useCallback(() => setPos(null), [])
  const options = useMemo(() => [...unsorted].sort((a, b) => a.tag.localeCompare(b.tag)), [unsorted])
  const chosen = options.filter((o) => selected.includes(o.tag)).length

  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null) => target instanceof Node && (popRef.current?.contains(target) || buttonRef.current?.contains(target))
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      buttonRef.current?.focus()
    }
    const onScroll = (e: Event) => {
      if (!inside(e.target)) close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  const toggle = () => {
    if (open) return close()
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8)) })
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
        className={cn(
          'cursor-pointer rounded-full border px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          chosen > 0 ? 'border-accent bg-accent text-on-accent' : 'border-line bg-surface text-ink hover:border-accent',
          total === 0 && chosen === 0 && 'opacity-50',
        )}
      >
        {prefix} <span className={chosen > 0 ? 'opacity-80' : 'text-muted'}>{chosen > 0 ? `${chosen} chosen` : total}</span> {open ? '▴' : '▾'}
      </button>
      {pos && (
        <div
          ref={popRef}
          role="group"
          aria-label={`${prefix} tags`}
          style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
          className="fixed z-50 max-h-72 overflow-y-auto rounded-lg border border-line bg-surface p-2 shadow-lg"
        >
          {options.map(({ tag, count }) => (
            <label key={tag} className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-black/5', count === 0 && !selected.includes(tag) && 'opacity-50')}>
              <input type="checkbox" checked={selected.includes(tag)} onChange={() => onToggle(tag)} />
              <span className="min-w-0 flex-1 break-words">{tag.slice(prefix.length + 1)}</span>
              <span className="text-muted">{count}</span>
            </label>
          ))}
        </div>
      )}
    </>
  )
}
