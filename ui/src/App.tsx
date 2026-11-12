import { useMemo, useState } from 'react'
import { useProducts } from './api/queries'
import { useHistoryDays } from './hooks/useHistoryDays'
import { useSidebarOpen } from './hooks/useSidebarOpen'
import { useSort } from './hooks/useSort'
import { AddProductDialog } from './components/AddProductDialog'
import { HistoryRangePicker } from './components/HistoryRangePicker'
import { ProductList } from './components/ProductList'
import { SearchBox } from './components/SearchBox'
import { SortPicker } from './components/SortPicker'
import { SyncStatus } from './components/SyncStatus'
import { TagFilter } from './components/TagFilter'
import { TypeFilter } from './components/TypeFilter'
import { Button } from './components/ui/Button'
import { Notice } from './components/ui/Notice'
import { cn } from './lib/cn'
import { groupProducts } from './lib/group'
import { filterProducts, prefixCounts, tagCounts, typeCounts } from './lib/filter'

export default function App() {
  const { data, isPending, isError, refetch } = useProducts()
  const [historyDays, setHistoryDays] = useHistoryDays()
  const [sort, setSort] = useSort()
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [chosenTags, setChosenTags] = useState<string[]>([])
  const [sidebarOpen, toggleSidebar] = useSidebarOpen()
  const [inStockOnly, setInStockOnly] = useState(false)

  // Products the store files in one collection are a single product to it, so they are here too.
  const products = useMemo(() => groupProducts(data?.products ?? []), [data?.products])
  const allTypes = useMemo(() => typeCounts(products), [products])
  // A chosen type that no longer has any products (e.g. after a refetch) shouldn't hide everything.
  const activeType = allTypes.some((t) => t.type === type) ? type : ''
  // Tags carried by a single product are just clutter, so they're left out of the filter.
  const tags = useMemo(() => tagCounts(products).filter((t) => t.count > 1), [products])
  // Likewise for tags: one the store dropped (a sale ending) mustn't keep filtering.
  const activeTags = useMemo(() => chosenTags.filter((t) => tags.some((c) => c.tag === t)), [chosenTags, tags])
  const toggleTag = (tag: string) => setChosenTags(activeTags.includes(tag) ? activeTags.filter((t) => t !== tag) : [...activeTags, tag])
  const shown = useMemo(
    () => filterProducts(products, query, activeType, activeTags, inStockOnly),
    [products, query, activeType, activeTags, inStockOnly],
  )
  // Type counts reflect everything but the type itself, so the other types show what choosing them would give.
  const withoutType = useMemo(
    () => filterProducts(products, query, '', activeTags, inStockOnly),
    [products, query, activeTags, inStockOnly],
  )
  const types = useMemo(() => typeCounts(products, withoutType), [products, withoutType])
  // Tag chip counts reflect the search and every other filter, not the whole catalog.
  const shownTags = useMemo(
    () => tagCounts(products, shown).filter((t) => tags.some((c) => c.tag === t.tag)),
    [products, shown, tags],
  )
  const groupTotals = useMemo(() => prefixCounts(shown), [shown])

  return (
    // On wide screens the page itself never scrolls: the filter column and the results each scroll on their own.
    <main className={cn('mx-auto flex max-w-3xl flex-col px-4 pt-6 pb-12 lg:h-dvh lg:pb-4', sidebarOpen && 'lg:max-w-[96rem]')}>
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Restock Radar</h1>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            aria-expanded={sidebarOpen}
            onClick={toggleSidebar}
            className="hidden px-3 text-sm lg:inline-flex"
          >
            {sidebarOpen ? '◂ Hide filters' : '▸ Show filters'}
          </Button>
          <AddProductDialog regions={data?.regions ?? []} />
        </div>
      </div>

      {data && <TypeFilter types={types} selected={activeType} total={withoutType.length} onChange={setType} />}

      <div
        className={cn(
          'mt-3 lg:grid lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)] lg:gap-6',
          sidebarOpen ? 'lg:grid-cols-[18rem_minmax(0,1fr)]' : 'lg:grid-cols-[minmax(0,1fr)]',
        )}
      >
        <aside aria-label="Search and filters" className={cn('lg:min-h-0', sidebarOpen ? 'lg:flex lg:flex-col lg:overflow-y-auto' : 'lg:hidden')}>
          <div className="flex">
            <SearchBox value={query} onChange={setQuery} />
          </div>
          <label className="mt-3 mb-4 flex cursor-pointer items-center gap-1.5 text-sm">
            <input type="checkbox" checked={inStockOnly} onChange={(e) => setInStockOnly(e.target.checked)} />
            In stock only
          </label>
          {data && <TagFilter tags={shownTags} groupTotals={groupTotals} selected={activeTags} onToggle={toggleTag} onClear={() => setChosenTags([])} />}
        </aside>

        <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div>{data && <SyncStatus lastSync={data.last_sync} productCount={products.length} />}</div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <SortPicker sort={sort} onChange={setSort} />
              <HistoryRangePicker days={historyDays} onChange={setHistoryDays} />
            </div>
          </div>

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
        </div>
      </div>
    </main>
  )
}
