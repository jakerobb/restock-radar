import { useProducts } from './api/queries'
import { AddProductForm } from './components/AddProductForm'
import { ProductList } from './components/ProductList'
import { SyncStatus } from './components/SyncStatus'
import { Notice } from './components/ui/Notice'

export default function App() {
  const { data, isPending, isError, refetch } = useProducts()

  return (
    <main className="mx-auto max-w-3xl px-4 pt-6 pb-12">
      <h1 className="text-2xl font-bold">Restock Radar</h1>
      <div className="mt-1 mb-5">
        {data && <SyncStatus lastSync={data.last_sync} productCount={data.products.length} />}
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
      {data && <ProductList data={data} />}
    </main>
  )
}
