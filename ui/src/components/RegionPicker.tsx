import { useEffect, useId, useRef, useState } from 'react'
import { useRegion } from '../hooks/useRegion'
import { cn } from '../lib/cn'
import { FLAG_URLS } from '../lib/flags'
import { REGIONS, regionName } from '../lib/region'

function Flag({ region }: { region: string }) {
  const src = FLAG_URLS[REGIONS[region]?.flag ?? '']
  if (!src) return <span aria-hidden className="inline-block h-3.5 w-[1.1667rem] rounded-[2px] bg-line" />
  return <img src={src} alt="" aria-hidden className="h-3.5 w-[1.1667rem] rounded-[2px] border border-line object-cover" />
}

/** A dropdown choosing which store's products the site shows; nothing when there is only one to choose. */
export function RegionPicker() {
  const { region, regions, setRegion } = useRegion()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  if (regions.length < 2) return null

  const choose = (id: string) => {
    setRegion(id)
    setOpen(false)
  }
  const show = () => {
    setActive(Math.max(0, regions.indexOf(region)))
    setOpen(true)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return show()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : regions.length - 1)) % regions.length)
    } else if (e.key === 'Home' || e.key === 'End') {
      if (!open) return
      e.preventDefault()
      setActive(e.key === 'Home' ? 0 : regions.length - 1)
    } else if ((e.key === 'Enter' || e.key === ' ') && open) {
      e.preventDefault()
      choose(regions[active] ?? region)
    }
  }

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        type="button"
        role="combobox"
        aria-label="Store region"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${regions[active]}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1 text-sm text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Flag region={region} />
        <span>{regionName(region)}</span>
        <span aria-hidden className="text-muted">
          ▾
        </span>
      </button>
      {open && (
        <ul id={listId} role="listbox" aria-label="Store region" className="absolute right-0 z-20 mt-1 min-w-48 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg">
          {regions.map((id, i) => (
            <li
              key={id}
              id={`${listId}-${id}`}
              role="option"
              aria-selected={id === region}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(id)}
              className={cn('flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm', i === active && 'bg-line/40', id === region && 'font-semibold')}
            >
              <Flag region={id} />
              <span>{regionName(id)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
