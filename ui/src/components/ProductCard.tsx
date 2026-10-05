import type { Product } from '../api/types'
import { summarizeVariants } from '../lib/status'
import { VariantTable } from './VariantTable'
import { Badge } from './ui/Badge'
import { Card } from './ui/Card'

interface ProductCardProps {
  product: Product
  /** Label the region, which is only worth saying when there's more than one. */
  showRegion: boolean
}

/** One product: its name and overall stock, with every variant beneath it. */
export function ProductCard({ product, showRegion }: ProductCardProps) {
  const { label, tone } = summarizeVariants(product.variants)
  return (
    <Card aria-label={product.title}>
      <h2 className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-lg font-semibold">
        <a className="text-accent underline-offset-2 hover:underline" href={product.url} target="_blank" rel="noopener noreferrer">
          {product.title}
        </a>
        <Badge tone={tone}>{label}</Badge>
        {showRegion && <span className="text-sm font-normal text-muted">{product.region}</span>}
      </h2>
      <VariantTable variants={product.variants} />
    </Card>
  )
}
