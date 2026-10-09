import type { Product } from '../api/types'
import type { HistoryIndex } from '../lib/history'
import { summarizeVariants } from '../lib/status'
import { HistoryLegend } from './HistoryLegend'
import { VariantHistoryChart } from './VariantHistoryChart'
import { VariantTable } from './VariantTable'
import { Badge } from './ui/Badge'
import { Card } from './ui/Card'

interface ProductCardProps {
  product: Product
  /** Label the region, which is only worth saying when there's more than one. */
  showRegion: boolean
  /** The price and stock history; the charts are left out until it's loaded. */
  history?: HistoryIndex
}

/** One product: its name and overall stock, with every variant beneath it. */
export function ProductCard({ product, showRegion, history }: ProductCardProps) {
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
      {history && (
        <div className="mb-1">
          <HistoryLegend days={history.days} />
        </div>
      )}
      <VariantTable
        variants={product.variants}
        chartFor={history && ((variant) => <VariantHistoryChart product={product} variant={variant} history={history} />)}
      />
    </Card>
  )
}
