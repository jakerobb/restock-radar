import type { ProductsResponse } from '../api/types'
import { useHistory } from '../api/queries'
import { PendingList } from './PendingList'
import { ProductCard } from './ProductCard'

export function ProductList({ data }: { data: ProductsResponse }) {
  const { data: history } = useHistory()
  const showRegion = data.regions.length > 1
  if (data.products.length === 0 && data.pending.length === 0) {
    return <p className="py-8 text-center text-muted">No products tracked yet. Add one above.</p>
  }
  return (
    <div className="flex flex-col gap-3">
      {data.products.map((product) => (
        <ProductCard key={`${product.region}/${product.id}`} product={product} showRegion={showRegion} history={history} />
      ))}
      <PendingList items={data.pending} />
    </div>
  )
}
