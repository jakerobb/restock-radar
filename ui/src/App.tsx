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
import { TypeFilter } from './components/TypeFilter'
import { Notice } from './components/ui/Notice'
import { filterProducts, typeCounts } from './lib/filter'

export default function App() {
  const { data, isPending, isError, refetch } = useProducts()
  const [historyDays, setHistoryDays] = useHistoryDays()
  const [sort, setSort] = useSort()
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')

  const types = useMemo(() => typeCounts(data?.products ?? []), [data?.products])
  // A chosen type that no longer has any products (e.g. after a refetch) shouldn't hide everything.
  const activeType = types.some((t) => t.type === type) ? type : ''
  const shown = useMemo(() => filterProducts(data?.products ?? [], query, activeType), [data?.products, query, activeType])

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
          <SortPicker sort={sort} onChange={setSort} />
          <HistoryRangePicker days={historyDays} onChange={setHistoryDays} />
        </div>
      </div>

      {data && <TypeFilter types={types} selected={activeType} total={data.products.length} onChange={setType} />}

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
        <ProductList data={data} products={shown} filtered={query.trim() !== '' || activeType !== ''} historyDays={historyDays} sort={sort} />
      )}
    </main>
  )
}
