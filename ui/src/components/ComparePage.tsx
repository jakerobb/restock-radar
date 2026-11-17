import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useDerived, useProducts } from '../api/queries'
import { buildCatalog, type CatalogRow } from '../lib/catalog'
import { buildComparison, cleanRefs, MAX_COMPARE, productRef } from '../lib/compare'
import { cn } from '../lib/cn'
import { matchesQuery, typeOf } from '../lib/filter'
import { statusInfo } from '../lib/status'
import { PageNav } from './PageNav'
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
function AddProduct({ catalog, chosen, onAdd }: { catalog: CatalogRow[]; chosen: CatalogRow[]; onAdd: (ref: string) => void }) {
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
  const full = chosen.length >= MAX_COMPARE
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

export default function ComparePage() {
  const search = useSearch({ strict: false }) as CompareSearch
  const navigate = useNavigate()
  const { data: productData, isPending, isError } = useProducts()
  const { data: derived, isError: derivedError } = useDerived()

  const refs = search.p ?? []
  const catalog = useMemo(() => buildCatalog(productData?.products ?? [], derived ?? []), [productData?.products, derived])
  const byRef = useMemo(() => new Map(catalog.map((r) => [productRef(r.product), r])), [catalog])
  const rows = refs.flatMap((ref) => byRef.get(ref) ?? [])
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
          <AddProduct catalog={catalog} chosen={rows} onAdd={(ref) => setRefs(cleanRefs([...refs, ref]))} />
          {rows.length < 2 && (
            <p className="py-6 text-muted">
              {rows.length === 0 ? 'Choose at least two products to compare, here or from the ' : 'Choose one more product, or pick several in the '}
              <Link to="/find" className="underline">
                finder
              </Link>
              .
            </p>
          )}
          {rows.length > 0 && (
            <Card className="mt-4 overflow-x-auto p-0" aria-label="Comparison">
              <label className="flex cursor-pointer items-center gap-1.5 border-b border-line px-3 py-2 text-sm">
                <input type="checkbox" checked={!!search.diff} onChange={(e) => update({ diff: e.target.checked || undefined })} />
                Show only the differences
              </label>
              <table className="w-full min-w-max border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line align-top">
                    <td />
                    {rows.map((r) => {
                      const status = r.price.stock === 'in' ? statusInfo('Available') : r.price.stock === 'soon' ? statusInfo('ComingSoon') : statusInfo('SoldOut')
                      return (
                        <th key={productRef(r.product)} scope="col" className="min-w-44 px-3 py-3 text-left font-normal">
                          <Link to="/p/$region/$slug" params={{ region: r.product.region, slug: r.product.slug }} className="font-semibold text-accent underline-offset-2 hover:underline">
                            {r.product.title}
                          </Link>
                          <div className="mt-1">
                            <Badge tone={status.tone}>{status.label}</Badge>
                          </div>
                          <button
                            type="button"
                            aria-label={`Remove ${r.product.title}`}
                            onClick={() => setRefs(refs.filter((x) => x !== productRef(r.product)))}
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
                        <th colSpan={rows.length + 1} scope="colgroup" className="bg-canvas px-3 py-1.5 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                          {s.title}
                        </th>
                      </tr>
                      {lines.map((l) => (
                        <tr key={l.id} className="border-b border-line align-top last:border-0">
                          <th scope="row" className="px-3 py-2 text-left font-normal text-muted">
                            {l.label}
                          </th>
                          {l.cells.map((cell, i) => (
                            <td key={i} className={cn('px-3 py-2', l.best[i] && 'font-semibold text-accent')}>
                              {cell === null ? (
                                <span className="text-muted">?</span>
                              ) : (
                                cell.map((t, j) => <div key={j}>{t}</div>)
                              )}
                              {l.best[i] && <span className="sr-only"> (best)</span>}
                            </td>
                          ))}
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
