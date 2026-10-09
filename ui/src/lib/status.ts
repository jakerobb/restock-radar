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

/**
 * One line for a whole product: "In stock", "Sold out", "Coming soon" (any
 * status all its variants share), or "1 of 2 in stock" when they differ.
 */
export function summarizeVariants(variants: Variant[]): StatusInfo {
  const first = variants[0]
  if (first && variants.every((v) => v.status === first.status)) return statusInfo(first.status)
  if (!first) return statusInfo('SoldOut')
  const inStock = variants.filter((v) => v.status === 'Available').length
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
