import { useMemo } from 'react'
import type { Product, ProductsResponse } from '../api/types'
import { useHistory } from '../api/queries'
import { indexHistory } from '../lib/history'
import { sortProducts, type SortKey } from '../lib/sort'
import { PendingList } from './PendingList'
import { ProductCard } from './ProductCard'

interface ProductListProps {
  data: ProductsResponse
  /** The products to show: `data.products` after any search and filter. */
  products: Product[]
  /** Whether a search or filter is narrowing the list. */
  filtered: boolean
  historyDays: number
  sort: SortKey
}

export function ProductList({ data, products: shown, filtered, historyDays, sort }: ProductListProps) {
  const { data: historyData } = useHistory(historyDays)
  const history = useMemo(() => historyData && indexHistory(historyData), [historyData])
  const products = useMemo(() => sortProducts(shown, sort), [shown, sort])
  const showRegion = data.regions.length > 1
  if (data.products.length === 0 && data.pending.length === 0) {
    return <p className="py-8 text-center text-muted">No products tracked yet. Use “Add product” to start.</p>
  }
  if (filtered && products.length === 0) {
    return <p className="py-8 text-center text-muted">No products match your search.</p>
  }
  return (
    <div className="flex flex-col gap-3">
      {products.map((product) => (
        <ProductCard key={`${product.region}/${product.id}`} product={product} showRegion={showRegion} history={history} />
      ))}
      {!filtered && <PendingList items={data.pending} />}
    </div>
  )
}
