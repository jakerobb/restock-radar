import { useMemo, useState } from 'react'
import { useProducts } from './api/queries'
import { useHistoryDays } from './hooks/useHistoryDays'
import { useSort } from './hooks/useSort'
import { AddProductDialog } from './components/AddProductDialog'
import { HistoryRangePicker } from './components/HistoryRangePicker'
import { ProductList } from './components/ProductList'
import { SearchBox } from './components/SearchBox'
import { SortPicker } from './components/SortPicker'
import { SyncStatus } from './components/SyncStatus'
import { TagFilter } from './components/TagFilter'
import { TypeFilter } from './components/TypeFilter'
import { Notice } from './components/ui/Notice'
import { filterProducts, tagCounts, typeCounts } from './lib/filter'

export default function App() {
  const { data, isPending, isError, refetch } = useProducts()
  const [historyDays, setHistoryDays] = useHistoryDays()
  const [sort, setSort] = useSort()
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [chosenTags, setChosenTags] = useState<string[]>([])
  const [inStockOnly, setInStockOnly] = useState(false)

  const types = useMemo(() => typeCounts(data?.products ?? []), [data?.products])
  // A chosen type that no longer has any products (e.g. after a refetch) shouldn't hide everything.
  const activeType = types.some((t) => t.type === type) ? type : ''
  // Tags carried by a single product are just clutter, so they're left out of the filter.
  const tags = useMemo(() => tagCounts(data?.products ?? []).filter((t) => t.count > 1), [data?.products])
  // Likewise for tags: one the store dropped (a sale ending) mustn't keep filtering.
  const activeTags = useMemo(() => chosenTags.filter((t) => tags.some((c) => c.tag === t)), [chosenTags, tags])
  const toggleTag = (tag: string) => setChosenTags(activeTags.includes(tag) ? activeTags.filter((t) => t !== tag) : [...activeTags, tag])
  const shown = useMemo(
    () => filterProducts(data?.products ?? [], query, activeType, activeTags, inStockOnly),
    [data?.products, query, activeType, activeTags, inStockOnly],
  )
  // Chip counts reflect the search and every other filter, not the whole catalog.
  const shownTags = useMemo(
    () => tagCounts(data?.products ?? [], shown).filter((t) => tags.some((c) => c.tag === t.tag)),
    [data?.products, shown, tags],
  )

  return (
    <main className="mx-auto max-w-3xl px-4 pt-6 pb-12">
      <h1 className="text-2xl font-bold">Restock Radar</h1>
      <div className="mt-3 flex gap-2">
        <SearchBox value={query} onChange={setQuery} />
        <AddProductDialog regions={data?.regions ?? []} />
      </div>
      <div className="mt-3 mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>{data && <SyncStatus lastSync={data.last_sync} productCount={data.products.length} />}</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-sm">
            <input type="checkbox" checked={inStockOnly} onChange={(e) => setInStockOnly(e.target.checked)} />
            In stock only
          </label>
          <SortPicker sort={sort} onChange={setSort} />
          <HistoryRangePicker days={historyDays} onChange={setHistoryDays} />
        </div>
      </div>

      {data && <TypeFilter types={types} selected={activeType} total={data.products.length} onChange={setType} />}
      {data && <TagFilter tags={shownTags} selected={activeTags} onToggle={toggleTag} onClear={() => setChosenTags([])} />}

      {isPending && <p className="py-8 text-center text-muted">Loading…</p>}
      {isError && !data && (
        <Notice tone="bad">
          Couldn't load products.{' '}
          <button className="cursor-pointer underline" onClick={() => refetch()}>
            Retry
          </button>
        </Notice>
      )}
      {data && (
        <ProductList data={data} products={shown} filtered={query.trim() !== '' || activeType !== '' || activeTags.length > 0 || inStockOnly} historyDays={historyDays} sort={sort} />
      )}
    </main>
  )
}
