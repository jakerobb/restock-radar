import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Product } from '../api/types'
import { productRef } from '../lib/compare'
import { matchesQuery, typeOf } from '../lib/filter'
import { formatPrice } from '../lib/format'
import { defaultVariant, lineFor, type PlanLine } from '../lib/plan'
import { cn } from '../lib/cn'
import { Dialog } from './Dialog'
import { PlanRegionNotice } from './PlanRegionNotice'
import { Badge } from './ui/Badge'
import { TextInput } from './ui/TextInput'

/** The most results listed; a longer list is a cue to type more. */
const MAX_RESULTS = 30

/** Products matching the words typed, those whose name has the whole phrase first, then those in stock. */
export function searchProducts(products: Product[], query: string): Product[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const rank = (p: Product) => (p.title.toLowerCase().includes(q) ? 0 : 2) + (p.variants.some((v) => v.status === 'Available') ? 0 : 1)
  return products
    .filter((p) => matchesQuery(p, q))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p)
}

/** A quick search over the catalogue; picking a result (click, or arrows and Enter) adds it to the plan. Esc closes it. */
export function PlanSearch({ products, inPlan, refs, onAdd, onClose }: { products: Product[]; inPlan: (ref: string) => number; /** What the plan holds, "region/slug" each. */ refs: string[]; onAdd: (line: PlanLine) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [added, setAdded] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const matches = useMemo(() => searchProducts(products, query), [products, query])
  const shown = matches.slice(0, MAX_RESULTS)
  const current = Math.min(active, shown.length - 1)
  const optionId = (i: number) => `plan-search-option-${i}`

  const pick = (p: Product) => {
    const line = lineFor(p)
    if (!line) return
    onAdd(line)
    setAdded(p.title)
  }
  const move = (to: number) => {
    setActive(to)
    listRef.current?.children[to]?.scrollIntoView?.({ block: 'nearest' })
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (shown.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move((current + 1) % shown.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move((current - 1 + shown.length) % shown.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const p = shown[current]
      if (p) pick(p)
    }
  }

  return (
    <Dialog title="Add a product" onClose={onClose}>
      <PlanRegionNotice refs={refs} />
      <TextInput
        data-autofocus
        className="w-full"
        role="combobox"
        aria-expanded={shown.length > 0}
        aria-controls="plan-search-results"
        aria-activedescendant={shown.length > 0 ? optionId(current) : undefined}
        aria-autocomplete="list"
        aria-label="Search products to add"
        placeholder="Name, SKU, category…"
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          setAdded(null)
        }}
        onKeyDown={onKeyDown}
      />
      <p className="mt-2 min-h-5 text-sm text-muted" role="status">
        {added ? `Added ${added}.` : query.trim() && shown.length === 0 ? 'Nothing matches.' : 'Click a result, or use ↑ ↓ and Enter, to add it.'}
      </p>
      <ul ref={listRef} id="plan-search-results" role="listbox" aria-label="Matching products" className="mt-1 max-h-80 divide-y divide-line overflow-y-auto">
        {shown.map((p, i) => {
          const line = lineFor(p)
          const count = inPlan(productRef(p))
          const inStock = p.variants.some((v) => v.status === 'Available')
          return (
            <li
              key={productRef(p)}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              className={cn('flex cursor-pointer items-baseline justify-between gap-3 px-2 py-2 text-sm', i === current && 'bg-accent/10')}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => pick(p)}
            >
              <span className="min-w-0">
                <span className="block truncate">{p.title}</span>
                <span className="block text-xs text-muted">
                  {typeOf(p)}
                  {count > 0 && ` · in plan (${count})`}
                </span>
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                {line?.addedCents != null && <span className="tabular-nums">{formatPrice(line.addedCents, defaultVariant(p)?.currency ?? 'USD')}</span>}
                <Badge tone={inStock ? 'ok' : 'bad'}>{inStock ? 'In stock' : 'Not in stock'}</Badge>
              </span>
            </li>
          )
        })}
      </ul>
      {matches.length > shown.length && <p className="mt-2 text-xs text-muted">{matches.length - shown.length} more; type more to narrow it down.</p>}
    </Dialog>
  )
}
