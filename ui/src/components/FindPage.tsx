import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useDerived, useProducts } from '../api/queries'
import { buildCatalog, columnById, defaultColumns, COLUMNS, NAME_SORT, PRICE_SORT, sortRows, type CatalogRow } from '../lib/catalog'
import { useRegion } from '../hooks/useRegion'
import { inRegion } from '../lib/region'
import { MAX_COMPARE, productRef } from '../lib/compare'
import { matchesQuery, typeCounts, typeOf } from '../lib/filter'
import { formatPrice } from '../lib/format'
import { describeRequirement, judge, parseRequirements, serializeRequirement, type Judgement, type Requirement } from '../lib/requirements'
import { statusInfo } from '../lib/status'
import { AddToPlan } from './AddToPlan'
import { PageNav } from './PageNav'
import { RequirementForm } from './RequirementForm'
import { TypeFilter } from './TypeFilter'
import { Badge } from './ui/Badge'
import { Card } from './ui/Card'
import { Notice } from './ui/Notice'
import { TextInput } from './ui/TextInput'
import { cn } from '../lib/cn'

/** What the finder keeps in the URL, so a search can be bookmarked and shared. */
export interface FindSearch {
  type?: string
  /** Requirements in their text form (see serializeRequirement). */
  r?: string[]
  q?: string
  stock?: boolean
  sort?: string
  dir?: 'asc' | 'desc'
  /** Chosen columns; the type's defaults when absent. */
  cols?: string[]
  /** Products picked to compare, as "region/slug". */
  c?: string[]
}

/** Makes whatever the URL holds into a valid search; nothing in the URL can break the page. */
export function validateFindSearch(raw: Record<string, unknown>): FindSearch {
  const strings = (v: unknown): string[] | undefined => {
    const list = Array.isArray(v) ? v : v === undefined ? [] : [v]
    const out = list.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(String)
    return out.length > 0 ? out : undefined
  }
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined) || undefined
  return {
    type: text(raw.type),
    r: strings(raw.r),
    q: text(raw.q),
    stock: raw.stock === true || raw.stock === 'true' ? true : undefined,
    sort: text(raw.sort),
    dir: raw.dir === 'asc' || raw.dir === 'desc' ? raw.dir : undefined,
    cols: strings(raw.cols),
    c: strings(raw.c)?.slice(0, MAX_COMPARE),
  }
}

interface Scored {
  row: CatalogRow
  judgement: Judgement
}

function ResultTable({ rows, columns, sort, dir, onSort, reqs, picked, onPick }: {
  rows: Scored[]
  columns: string[]
  sort: string
  dir: 'asc' | 'desc'
  onSort: (key: string) => void
  reqs: Requirement[]
  picked: string[]
  onPick: (ref: string, on: boolean) => void
}) {
  const cols = columns.map(columnById).filter((c) => c !== undefined)
  const head = (key: string, label: string, align = 'text-left') => (
    <th scope="col" aria-sort={sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn('px-2 py-1.5 font-medium', align)}>
      <button type="button" onClick={() => onSort(key)} className="cursor-pointer whitespace-nowrap hover:text-accent">
        {label}
        {sort === key && <span aria-hidden> {dir === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </th>
  )
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead className="border-b border-line text-muted">
          <tr>
            <th scope="col" className="w-8 px-2 py-1.5">
              <span className="sr-only">Compare</span>
            </th>
            {head(NAME_SORT, 'Product')}
            {head(PRICE_SORT, 'Price', 'text-right')}
            <th scope="col" className="px-2 py-1.5 text-left font-medium">
              Stock
            </th>
            {cols.map((c) => head(c.id, c.label, 'text-right'))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, judgement }) => {
            const { product, price } = row
            const status = price.stock === 'in' ? statusInfo('Available') : price.stock === 'soon' ? statusInfo('ComingSoon') : statusInfo('SoldOut')
            return (
              <tr key={productRef(product)} className="border-b border-line align-top last:border-0">
                <td className="px-2 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Compare ${product.title}`}
                    checked={picked.includes(productRef(product))}
                    disabled={!picked.includes(productRef(product)) && picked.length >= MAX_COMPARE}
                    onChange={(e) => onPick(productRef(product), e.target.checked)}
                  />
                </td>
                <td className="px-2 py-2">
                  <Link to="/p/$region/$slug" params={{ region: product.region, slug: product.slug }} className="font-medium text-accent underline-offset-2 hover:underline">
                    {product.title}
                  </Link>
                  <AddToPlan product={product} className="ml-3" />
                  {reqs.length > 0 && (
                    <ul className="mt-0.5 text-xs text-muted">
                      {judgement.outcomes.map((o, i) => (
                        <li key={i}>
                          <span aria-hidden>{o.verdict === 'match' ? '✓' : '?'}</span> {describeRequirement(reqs[i]!)}: {o.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                  {price.cents === null ? <span className="text-muted">n/a</span> : <span className={price.buyable ? '' : 'text-muted'}>{formatPrice(price.cents, price.currency)}</span>}
                  {price.variants > 1 && price.cents !== null && <span className="text-muted"> +</span>}
                </td>
                <td className="px-2 py-2 whitespace-nowrap">
                  <Badge tone={status.tone}>{price.variants > 1 && price.stock === 'in' ? `${price.inStock} of ${price.variants} in stock` : status.label}</Badge>
                </td>
                {cols.map((c) => {
                  const v = c.value(row)
                  return (
                    <td key={c.id} className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                      {v === null ? <span className="text-muted">?</span> : c.format(v, row)}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function FindPage() {
  const search = useSearch({ strict: false }) as FindSearch
  const navigate = useNavigate()
  const { data: productData, isPending, isError } = useProducts()
  const { data: derived, isError: derivedError } = useDerived()
  const { region } = useRegion()

  const type = search.type ?? ''
  const reqs = useMemo(() => parseRequirements(search.r), [search.r])
  const columns = (search.cols ?? defaultColumns(type)).filter((id) => columnById(id))
  const sort = search.sort ?? NAME_SORT
  const dir = search.dir ?? 'asc'

  const update = (patch: Partial<FindSearch>) =>
    // Replace, not push: each tweak of a filter isn't a page to go "back" to.
    void navigate({ to: '/find', search: ((prev: FindSearch) => ({ ...validateFindSearch(prev as Record<string, unknown>), ...patch })) as never, replace: true })

  const catalog = useMemo(() => buildCatalog(inRegion(productData?.products ?? [], region), derived ?? []), [productData?.products, derived, region])
  const types = useMemo(() => typeCounts(catalog.map((r) => r.product)), [catalog])

  const scoped = useMemo(
    () => catalog.filter((r) => (type === '' || typeOf(r.product) === type) && matchesQuery(r.product, search.q ?? '') && (!search.stock || r.price.stock === 'in')),
    [catalog, type, search.q, search.stock],
  )
  const scored = useMemo(() => scoped.map((row) => ({ row, judgement: judge(reqs, row.derived) })), [scoped, reqs])
  const sortScored = (list: Scored[]) => {
    const order = sortRows(list.map((s) => s.row), sort, dir)
    const byRow = new Map(list.map((s) => [s.row, s]))
    return order.map((r) => byRow.get(r)!)
  }
  const matches = useMemo(() => sortScored(scored.filter((s) => s.judgement.verdict === 'match')), [scored, sort, dir]) // eslint-disable-line react-hooks/exhaustive-deps
  const unknown = useMemo(() => sortScored(scored.filter((s) => s.judgement.verdict === 'unknown')), [scored, sort, dir]) // eslint-disable-line react-hooks/exhaustive-deps
  const ruledOut = scored.length - matches.length - unknown.length

  const onSort = (key: string) => {
    const col = columnById(key)
    const first: 'asc' | 'desc' = key === NAME_SORT || col?.lowerIsBetter || key === PRICE_SORT ? 'asc' : 'desc'
    update(sort === key ? { sort: key, dir: dir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: first })
  }
  const picked = search.c ?? []
  const pick = (ref: string, on: boolean) => {
    const next = on ? [...picked.filter((x) => x !== ref), ref].slice(0, MAX_COMPARE) : picked.filter((x) => x !== ref)
    update({ c: next.length > 0 ? next : undefined })
  }
  const setReqs = (next: Requirement[]) => update({ r: next.length > 0 ? next.map(serializeRequirement) : undefined })

  return (
    <main className="mx-auto max-w-6xl px-4 pt-6 pb-12">
      <PageNav title="Product finder" />
      <p className="mt-1 text-sm text-muted">Say what you need; see which products can do it, with current price and stock.</p>

      {isPending && <p className="py-8 text-center text-muted">Loading…</p>}
      {(isError || derivedError) && <Notice tone="bad" className="mt-4">Couldn't load the catalogue.</Notice>}

      {productData && (
        <>
          <TypeFilter types={types} selected={type} total={catalog.length} onChange={(t) => update({ type: t || undefined, cols: undefined, sort: undefined, dir: undefined })} />

          <Card className="space-y-3" aria-label="Requirements">
            {reqs.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Current requirements">
                {reqs.map((r, i) => (
                  <li key={serializeRequirement(r)} className="flex items-center gap-1.5 rounded-full border border-line bg-canvas py-1 pr-1 pl-3 text-sm">
                    {describeRequirement(r)}
                    <button
                      type="button"
                      aria-label={`Remove: ${describeRequirement(r)}`}
                      onClick={() => setReqs(reqs.filter((_, j) => j !== i))}
                      className="cursor-pointer rounded-full px-2 text-muted hover:bg-line hover:text-ink"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <RequirementForm onAdd={(r) => setReqs([...reqs.filter((x) => serializeRequirement(x) !== serializeRequirement(r)), r])} />
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3">
              <TextInput type="search" className="min-w-0 flex-1 sm:max-w-xs" value={search.q ?? ''} onChange={(e) => update({ q: e.target.value || undefined })} placeholder="Search by name" aria-label="Search by name" />
              <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input type="checkbox" checked={!!search.stock} onChange={(e) => update({ stock: e.target.checked || undefined })} />
                In stock only
              </label>
              <details className="relative text-sm">
                <summary className="cursor-pointer text-muted hover:text-ink">Columns</summary>
                <div className="absolute z-10 mt-1 grid min-w-56 gap-1 rounded-lg border border-line bg-surface p-3 shadow-lg">
                  {COLUMNS.map((c, i) => (
                    <label key={c.id} className={cn('flex cursor-pointer items-center gap-1.5', c.group === 'value' && COLUMNS[i - 1]?.group !== 'value' && 'mt-2 border-t border-line pt-2')}>
                      <input
                        type="checkbox"
                        checked={columns.includes(c.id)}
                        onChange={(e) => update({ cols: e.target.checked ? [...columns, c.id] : columns.filter((x) => x !== c.id) })}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
              </details>
            </div>
          </Card>

          {picked.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm" role="status">
              <span>
                {picked.length} picked to compare{picked.length >= MAX_COMPARE ? ` (the most that fit: ${MAX_COMPARE})` : ''}
              </span>
              {picked.length >= 2 ? (
                <Link to="/compare" search={{ p: picked }} className="font-medium text-accent underline underline-offset-2">
                  Compare them
                </Link>
              ) : (
                <span className="text-muted">pick one more</span>
              )}
              <button type="button" onClick={() => update({ c: undefined })} className="cursor-pointer text-muted underline underline-offset-2 hover:text-ink">
                Clear
              </button>
            </div>
          )}

          <section className="mt-5" aria-label="Results">
            <h2 className="mb-2 text-lg font-semibold">
              {reqs.length > 0 ? `Matches (${matches.length})` : `Products (${matches.length})`}
            </h2>
            {matches.length > 0 ? (
              <ResultTable rows={matches} columns={columns} sort={sort} dir={dir} onSort={onSort} reqs={reqs} picked={picked} onPick={pick} />
            ) : (
              <p className="py-4 text-muted">{scoped.length === 0 ? 'Nothing here yet.' : 'No product is known to meet all of these.'}</p>
            )}

            {unknown.length > 0 && (
              <details className="mt-6">
                <summary className="cursor-pointer font-semibold">
                  Can't tell ({unknown.length}) <span className="font-normal text-muted">— the specifications don't say enough to judge</span>
                </summary>
                <div className="mt-2">
                  <ResultTable rows={unknown} columns={columns} sort={sort} dir={dir} onSort={onSort} reqs={reqs} picked={picked} onPick={pick} />
                </div>
              </details>
            )}
            {reqs.length > 0 && <p className="mt-4 text-sm text-muted">{ruledOut} products ruled out.</p>}
          </section>
        </>
      )}
    </main>
  )
}
