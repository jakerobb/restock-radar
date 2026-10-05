import type { Variant } from '../api/types'
import type { Tone } from '../components/ui/tone'

export interface StatusInfo {
  label: string
  tone: Tone
}

/** Maps the store's status string to something a person can read. */
export function statusInfo(status: string): StatusInfo {
  switch (status) {
    case 'Available':
      return { label: 'In stock', tone: 'ok' }
    case 'SoldOut':
      return { label: 'Sold out', tone: 'bad' }
    case 'ComingSoon':
      return { label: 'Coming soon', tone: 'warn' }
    default:
      return { label: status, tone: 'warn' }
  }
}

/** One line for a whole product: "In stock", "Sold out", or "1 of 2 in stock". */
export function summarizeVariants(variants: Variant[]): StatusInfo {
  const inStock = variants.filter((v) => v.status === 'Available').length
  if (inStock === variants.length && inStock > 0) return statusInfo('Available')
  if (inStock === 0) return statusInfo('SoldOut')
  return { label: `${inStock} of ${variants.length} in stock`, tone: 'warn' }
}

/**
 * The name to show for a variant. Single-variant products come through titled
 * "Default", which says nothing, so the SKU takes its place (and isn't repeated
 * beneath it).
 */
export function variantName(variant: Variant): { title: string; sku?: string } {
  if (variant.title === '' || variant.title.toLowerCase() === 'default') return { title: variant.sku }
  return { title: variant.title, sku: variant.sku }
}
