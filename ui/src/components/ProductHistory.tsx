import { useMemo } from 'react'
import type { HistoryResponse, Product, VariantHistory } from '../api/types'
import { buildHistoryModel } from '../lib/history'
import { statusInfo, variantName } from '../lib/status'
import { HistoryChart, stockFill } from './HistoryChart'

const LEGEND = ['Available', 'SoldOut', 'ComingSoon']

interface ProductHistoryProps {
  product: Product
  history: HistoryResponse
}

/** A chart per variant of a product, over the window the history covers. */
export function ProductHistory({ product, history }: ProductHistoryProps) {
  const byVariant = useMemo(
    () => new Map(history.variants.filter((h) => h.region === product.region).map((h) => [h.variant_id, h])),
    [history, product.region],
  )
  const days = Math.round((Date.parse(history.until) - Date.parse(history.since)) / 86_400_000)

  return (
    <section className="mt-3 border-t border-line pt-3" aria-label={`Last ${days} days`}>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <h3 className="font-medium">Last {days} days</h3>
        <ul className="flex flex-wrap gap-x-3">
          {LEGEND.map((status) => (
            <li key={status} className="flex items-center gap-1">
              <svg width="10" height="10" aria-hidden="true">
                <rect width="10" height="10" className={`${stockFill[statusInfo(status).tone]} stroke-line`} />
              </svg>
              {statusInfo(status).label}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-3">
        {product.variants.map((variant) => {
          const h = byVariant.get(variant.id)
          if (!h) return null
          const { title } = variantName(variant)
          return (
            <figure key={variant.id}>
              <figcaption className="mb-0.5 text-xs text-muted">{title}</figcaption>
              <VariantChart history={h} windowStart={Date.parse(history.since)} windowEnd={Date.parse(history.until)} currency={variant.currency} label={`${product.title}, ${title}: price and stock, last ${days} days`} />
            </figure>
          )
        })}
      </div>
    </section>
  )
}

interface VariantChartProps {
  history: VariantHistory
  windowStart: number
  windowEnd: number
  currency: string
  label: string
}

function VariantChart({ history, windowStart, windowEnd, currency, label }: VariantChartProps) {
  const model = useMemo(() => buildHistoryModel(history, windowStart, windowEnd), [history, windowStart, windowEnd])
  return <HistoryChart model={model} currency={currency} label={label} />
}
