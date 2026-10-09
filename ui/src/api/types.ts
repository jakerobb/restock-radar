// The shapes served by the Go API (src/internal/api/products.go).

export interface Variant {
  id: string
  sku: string
  title: string
  /** Store status: Available, SoldOut, ComingSoon, ... */
  status: string
  /** Minor units (cents); null when the store shows no price. */
  price_cents: number | null
  /** The pre-discount price, when different from price_cents. */
  regular_price_cents: number | null
  currency: string
  restock_eta?: string
  last_checked: string
  last_changed: string
}

export interface Product {
  region: string
  id: string
  slug: string
  title: string
  url: string
  variants: Variant[]
}

export interface PendingItem {
  region: string
  slug: string
}

export interface ProductsResponse {
  /** When the newest variant was last checked; null before the first poll. */
  last_sync: string | null
  regions: string[]
  products: Product[]
  pending: PendingItem[]
}

export interface AddItemRequest {
  item: string
  region?: string
}

export interface AddItemResult {
  region: string
  slug: string
  title: string
  variants: number
  already_tracked: boolean
}

/** A variant's state from `time` until the next point (or the end of known data). */
export interface HistoryPoint {
  time: string
  status: string
  price_cents: number | null
}

export interface VariantHistory {
  region: string
  variant_id: string
  /** Nothing is known before this (when the variant was first seen)... */
  from: string
  /** ...or after this (when it was last checked). */
  until: string
  points: HistoryPoint[]
}

export interface HistoryResponse {
  /** The window the points were selected for. */
  since: string
  until: string
  variants: VariantHistory[]
}
