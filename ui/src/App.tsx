import { useProducts } from './api/queries'
import { useHistoryDays } from './hooks/useHistoryDays'
import { useSort } from './hooks/useSort'
import { AddProductForm } from './components/AddProductForm'
import { HistoryRangePicker } from './components/HistoryRangePicker'
import { ProductList } from './components/ProductList'
import { SortPicker } from './components/SortPicker'
import { SyncStatus } from './components/SyncStatus'
import { Notice } from './components/ui/Notice'

export default function App() {
  const { data, isPending, isError, refetch } = useProducts()
  const [historyDays, setHistoryDays] = useHistoryDays()
  const [sort, setSort] = useSort()

  return (
    <main className="mx-auto max-w-3xl px-4 pt-6 pb-12">
      <h1 className="text-2xl font-bold">Restock Radar</h1>
      <div className="mt-1 mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>{data && <SyncStatus lastSync={data.last_sync} productCount={data.products.length} />}</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <SortPicker sort={sort} onChange={setSort} />
          <HistoryRangePicker days={historyDays} onChange={setHistoryDays} />
        </div>
      </div>

      <AddProductForm regions={data?.regions ?? []} />

      {isPending && <p className="py-8 text-center text-muted">Loading…</p>}
      {isError && !data && (
        <Notice tone="bad">
          Couldn't load products.{' '}
          <button className="cursor-pointer underline" onClick={() => refetch()}>
            Retry
          </button>
        </Notice>
      )}
      {data && <ProductList data={data} historyDays={historyDays} sort={sort} />}
    </main>
  )
}
