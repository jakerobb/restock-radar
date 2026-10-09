import { useMemo } from 'react'
import type { Product, Variant } from '../api/types'
import { buildHistoryModel, type HistoryIndex } from '../lib/history'
import { variantName } from '../lib/status'
import { HistoryChart } from './HistoryChart'

interface VariantHistoryChartProps {
  product: Product
  variant: Variant
  history: HistoryIndex
}

/** One variant's price and stock chart; nothing if it has no history yet. */
export function VariantHistoryChart({ product, variant, history }: VariantHistoryChartProps) {
  const h = history.variant(product.region, variant.id)
  const model = useMemo(() => h && buildHistoryModel(h, history.start, history.end), [h, history.start, history.end])
  if (!model) return null
  const label = `${product.title}, ${variantName(variant).title}: price and stock, last ${history.days} days`
  return <HistoryChart model={model} currency={variant.currency} label={label} />
}
