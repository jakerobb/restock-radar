import { useMemo } from 'react'
import type { ProductsResponse } from '../api/types'
import { useHistory } from '../api/queries'
import { indexHistory } from '../lib/history'
import { sortProducts, type SortKey } from '../lib/sort'
import { PendingList } from './PendingList'
import { ProductCard } from './ProductCard'

export function ProductList({ data, historyDays, sort }: { data: ProductsResponse; historyDays: number; sort: SortKey }) {
  const { data: historyData } = useHistory(historyDays)
  const history = useMemo(() => historyData && indexHistory(historyData), [historyData])
  const products = useMemo(() => sortProducts(data.products, sort), [data.products, sort])
  const showRegion = data.regions.length > 1
  if (data.products.length === 0 && data.pending.length === 0) {
    return <p className="py-8 text-center text-muted">No products tracked yet. Add one above.</p>
  }
  return (
    <div className="flex flex-col gap-3">
      {products.map((product) => (
        <ProductCard key={`${product.region}/${product.id}`} product={product} showRegion={showRegion} history={history} />
      ))}
      <PendingList items={data.pending} />
    </div>
  )
}
