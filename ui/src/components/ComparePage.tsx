import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useDerived, useProducts } from '../api/queries'
import type { Product } from '../api/types'
import { buildCatalog, type CatalogRow } from '../lib/catalog'
import { useRegion } from '../hooks/useRegion'
import { buildComparison, cleanRefs, MAX_COMPARE, productRef } from '../lib/compare'
import { cn } from '../lib/cn'
import { counterpart } from '../lib/convertPlan'
import { matchesQuery, typeOf } from '../lib/filter'
import { regionName } from '../lib/region'
import { statusInfo } from '../lib/status'
import { AddToPlan } from './AddToPlan'
import { PageNav } from './PageNav'
import { Flag } from './RegionPicker'
import { Badge } from './ui/Badge'
import { Card } from './ui/Card'
import { Notice } from './ui/Notice'
import { TextInput } from './ui/TextInput'

/** What the compare page keeps in the URL: the products, so a comparison can be shared. */
export interface CompareSearch {
  /** Products as "region/slug". */
  p?: string[]
  /** Show only the rows where the products differ. */
  diff?: boolean
}

export function validateCompareSearch(raw: Record<string, unknown>): CompareSearch {
  const list = Array.isArray(raw.p) ? raw.p : raw.p === undefined ? [] : [raw.p]
  const refs = cleanRefs(list.filter((x): x is string => typeof x === 'string'))
  return { p: refs.length > 0 ? refs : undefined, diff: raw.diff === true || raw.diff === 'true' ? true : undefined }
}

/** A search box that offers products to add, the first product's type first. */
function AddProduct({ catalog, chosen, count, onAdd }: { catalog: CatalogRow[]; chosen: CatalogRow[]; /** How many slots the comparison has, shown or not. */ count: number; onAdd: (ref: string) => void }) {
  const [text, setText] = useState('')
  const suggestions = useMemo(() => {
    if (text.trim() === '') return []
    const taken = new Set(chosen.map((r) => productRef(r.product)))
    const type = chosen[0] ? typeOf(chosen[0].product) : ''
    return catalog
      .filter((r) => !taken.has(productRef(r.product)) && matchesQuery(r.product, text))
      .sort((a, b) => Number(typeOf(b.product) === type) - Number(typeOf(a.product) === type) || a.product.title.localeCompare(b.product.title))
      .slice(0, 8)
  }, [catalog, chosen, text])
  const full = count >= MAX_COMPARE
  return (
    <div className="mt-4">
      <TextInput
        type="search"
        className="w-full sm:max-w-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={full ? `Up to ${MAX_COMPARE} products` : 'Add a product by name'}
        aria-label="Add a product"
        disabled={full}
      />
      {suggestions.length > 0 && (
        <ul className="mt-1 max-w-sm divide-y divide-line rounded-lg border border-line bg-surface text-sm" aria-label="Suggestions">
          {suggestions.map((r) => (
            <li key={productRef(r.product)}>
              <button
                type="button"
                className="flex w-full cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-left hover:bg-canvas"
                onClick={() => {
                  onAdd(productRef(r.product))
                  setText('')
                }}
              >
                <span>{r.product.title}</span>
                <span className="text-xs text-muted">{typeOf(r.product)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** What a slot of the comparison shows: the product it names in the picked region, or why there is none. */
interface Slot {
  /** What the URL holds, which is where the slot comes from whichever region is picked. */
  ref: string
  /** The product the slot names, when it is tracked. */
  source?: CatalogRow
  /** The picked region's version of it. */
  shown?: CatalogRow
}

/** The header of a slot with no product in the picked region: says so, and where it is sold. */
function UnavailableHeader({ slot, region, regions, products, onRemove }: { slot: Slot; region: string; regions: string[]; products: Product[]; onRemove: () => void }) {
  const source = slot.source!.product
  const elsewhere = regions.flatMap((r) => {
    const p = r === source.region ? source : counterpart(source, r, products)
    return p ? [p] : []
  })
  return (
    <th scope="col" className="min-w-44 px-3 py-3 text-left font-normal">
      <div className="font-semibold">{source.title}</div>
      <p className="mt-1 text-muted">Not available in {regionName(region)}.</p>
      {elsewhere.length > 0 && (
        <ul className="mt-1">
          {elsewhere.map((p) => (
            <li key={p.region}>
              <Link to="/p/$region/$slug" params={{ region: p.region, slug: p.slug }} className="inline-flex items-center gap-1.5 text-accent underline-offset-2 hover:underline">
                <Flag region={p.region} />
                {regionName(p.region)}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <button type="button" aria-label={`Remove ${source.title}`} onClick={onRemove} className="mt-1 cursor-pointer text-xs text-muted underline underline-offset-2 hover:text-ink">
        Remove
      </button>
    </th>
  )
}

export default function ComparePage() {
  const search = useSearch({ strict: false }) as CompareSearch
  const navigate = useNavigate()
  const { data: productData, isPending, isError } = useProducts()
  const { data: derived, isError: derivedError } = useDerived()
  const { region } = useRegion()

  const refs = useMemo(() => search.p ?? [], [search.p])
  const catalog = useMemo(() => buildCatalog(productData?.products ?? [], derived ?? []), [productData?.products, derived])
  const byRef = useMemo(() => new Map(catalog.map((r) => [productRef(r.product), r])), [catalog])
  // Each slot keeps the product it was made with; what it shows is that product's equivalent in the picked region.
  const slots = useMemo<Slot[]>(() => refs.flatMap((ref) => {
    const source = byRef.get(ref)
    if (!source) return []
    const shown = source.product.region === region ? source : byRef.get(productRef(counterpart(source.product, region, productData?.products ?? []) ?? { region: '', slug: '' }))
    return [{ ref, source, shown }]
  }), [refs, byRef, region, productData?.products])
  const rows = useMemo(() => slots.flatMap((s) => s.shown ?? []), [slots])
  const missing = productData ? refs.filter((ref) => !byRef.has(ref)) : []
  const sections = useMemo(() => buildComparison(rows), [rows])

  const update = (patch: CompareSearch) =>
    void navigate({ to: '/compare', search: ((prev: CompareSearch) => ({ ...validateCompareSearch(prev as Record<string, unknown>), ...patch })) as never, replace: true })
  const setRefs = (next: string[]) => update({ p: next.length > 0 ? next : undefined })

  return (
    <main className="mx-auto max-w-6xl px-4 pt-6 pb-12">
      <PageNav title="Compare" />
      <p className="mt-1 text-sm text-muted">Products side by side. Corrections to the published specifications are included.</p>

      {isPending && <p className="py-8 text-center text-muted">Loading…</p>}
      {(isError || derivedError) && <Notice tone="bad" className="mt-4">Couldn't load the catalogue.</Notice>}
      {missing.length > 0 && (
        <Notice tone="bad" className="mt-4">
          Not tracking {missing.map((m) => m).join(', ')}.{' '}
          <button type="button" className="cursor-pointer underline" onClick={() => setRefs(refs.filter((r) => !missing.includes(r)))}>
            Drop {missing.length === 1 ? 'it' : 'them'}
          </button>
        </Notice>
      )}

      {productData && (
        <>
          <AddProduct catalog={catalog.filter((r) => r.product.region === region)} chosen={rows} count={refs.length} onAdd={(ref) => setRefs(cleanRefs([...refs, ref]))} />
          {slots.length < 2 && (
            <p className="py-6 text-muted">
              {slots.length === 0 ? 'Choose at least two products to compare, here or from the ' : 'Choose one more product, or pick several in the '}
              <Link to="/find" className="underline">
                finder
              </Link>
              .
            </p>
          )}
          {slots.length > 0 && (
            <Card className="mt-4 overflow-x-auto p-0" aria-label="Comparison">
              <label className="flex cursor-pointer items-center gap-1.5 border-b border-line px-3 py-2 text-sm">
                <input type="checkbox" checked={!!search.diff} onChange={(e) => update({ diff: e.target.checked || undefined })} />
                Show only the differences
              </label>
              <table className="w-full min-w-max border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line align-top">
                    <td />
                    {slots.map((slot) => {
                      const r = slot.shown
                      if (!r) return <UnavailableHeader key={slot.ref} slot={slot} region={region} regions={productData.regions} products={productData.products} onRemove={() => setRefs(refs.filter((x) => x !== slot.ref))} />
                      const status = r.price.stock === 'in' ? statusInfo('Available') : r.price.stock === 'soon' ? statusInfo('ComingSoon') : statusInfo('SoldOut')
                      return (
                        <th key={productRef(r.product)} scope="col" className="min-w-44 px-3 py-3 text-left font-normal">
                          <Link to="/p/$region/$slug" params={{ region: r.product.region, slug: r.product.slug }} className="font-semibold text-accent underline-offset-2 hover:underline">
                            {r.product.title}
                          </Link>
                          <div className="mt-1">
                            <Badge tone={status.tone}>{status.label}</Badge>
                          </div>
                          <AddToPlan product={r.product} className="mt-1 mr-3" />
                          <button
                            type="button"
                            aria-label={`Remove ${r.product.title}`}
                            onClick={() => setRefs(refs.filter((x) => x !== slot.ref))}
                            className="mt-1 cursor-pointer text-xs text-muted underline underline-offset-2 hover:text-ink"
                          >
                            Remove
                          </button>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                {sections.map((s) => {
                  const lines = search.diff ? s.lines.filter((l) => l.differs) : s.lines
                  if (lines.length === 0) return null
                  return (
                    <tbody key={s.title} aria-label={s.title}>
                      <tr>
                        <th colSpan={slots.length + 1} scope="colgroup" className="bg-canvas px-3 py-1.5 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                          {s.title}
                        </th>
                      </tr>
                      {lines.map((l) => (
                        <tr key={l.id} className="border-b border-line align-top last:border-0">
                          <th scope="row" className="px-3 py-2 text-left font-normal text-muted">
                            {l.label}
                          </th>
                          {slots.map((slot) => {
                            const i = slot.shown ? rows.indexOf(slot.shown) : -1
                            if (i < 0) return <td key={slot.ref} className="px-3 py-2 text-muted">–</td>
                            const cell = l.cells[i]
                            return (
                              <td key={slot.ref} className={cn('px-3 py-2', l.best[i] && 'font-semibold text-accent')}>
                                {cell === null ? <span className="text-muted">?</span> : cell?.map((t, j) => <div key={j}>{t}</div>)}
                                {l.best[i] && <span className="sr-only"> (best)</span>}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  )
                })}
              </table>
            </Card>
          )}
        </>
      )}
    </main>
  )
}
