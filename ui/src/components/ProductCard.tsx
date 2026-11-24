import type { Product } from '../api/types'
import type { HistoryIndex } from '../lib/history'
import { summarizeVariants } from '../lib/status'
import { AddToPlan } from './AddToPlan'
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
  /** The card is on the product's own page, so a link to that page is no use. */
  onPage?: boolean
}

/** One product: its name and overall stock, with every variant beneath it. */
export function ProductCard({ product, showRegion, history, onPage = false }: ProductCardProps) {
  const { label, tone } = summarizeVariants(product.variants)
  // A merged group has no page of its own: each member has its own specification.
  const detailsHref = !onPage && !product.id.startsWith('collection:') ? `/p/${encodeURIComponent(product.region)}/${encodeURIComponent(product.slug)}` : undefined
  return (
    <Card aria-label={product.title}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1 text-lg font-semibold">
          {/* Where there's no details page to go to, the title goes to the store instead. */}
          {detailsHref ? (
            <a className="text-accent underline-offset-2 hover:underline" href={detailsHref}>
              {product.title}
            </a>
          ) : (
            <a className="text-accent underline-offset-2 hover:underline" href={product.url} target="_blank" rel="noopener noreferrer">
              {product.title}
            </a>
          )}
          {/* With one variant its row says the same. */}
          {product.variants.length > 1 && <Badge tone={tone}>{label}</Badge>}
          {showRegion && <span className="text-sm font-normal text-muted">{product.region}</span>}
        </h2>
        <div className="flex shrink-0 items-baseline gap-3 text-sm">
          <AddToPlan product={product} />
          <a className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline" href={product.url} target="_blank" rel="noopener noreferrer">
            Store
            <ExternalLinkIcon />
          </a>
          {product.techspecs_url && (
            <a className="text-accent underline-offset-2 hover:underline" href={product.techspecs_url} target="_blank" rel="noopener noreferrer">
              Tech specs
            </a>
          )}
        </div>
      </div>
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

/** The square with an arrow leaving its upper-right corner: the link leaves this site. */
function ExternalLinkIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </svg>
  )
}
