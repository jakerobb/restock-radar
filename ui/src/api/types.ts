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
  /** The out-the-door price: price_cents plus the store's surcharges; null until seen. */
  price_with_surcharges_cents: number | null
  /** The kinds of surcharge included in it ("Memory", "Tariff", ...); empty when none. Only the total is known, not each amount. */
  surcharge_types: string[]
  currency: string
  restock_eta?: string
  last_checked: string
  last_changed: string
  /** When the variant was first seen, i.e. when it started being tracked. */
  first_seen: string
  /** Client-side only: the tags of the member product this variant came from, set when products are grouped by collection. */
  tags?: string[]
}

export interface Product {
  region: string
  id: string
  slug: string
  title: string
  /** Product type for filtering (Gateways, Switches, ...); empty when not yet known. */
  type: string
  /** The store's category id (e.g. "physical-security-nvr"); empty when not yet known. */
  category: string
  /** The store's labels for the product ("black-friday", "feature:4k", ...); empty when none. */
  tags: string[]
  /** The store collection slug; products sharing one are a single product to the store. Empty when standalone. */
  collection: string
  /** The store's compact product name ("UniFi Etherlighting Patch Cable"); empty until a poll has seen it. */
  short_title: string
  /** The title the store's breadcrumbs file the product under ("UniFi Patch Cables"); products sharing one are shown as a unit. Empty until a poll has fetched the product page. */
  group: string
  url: string
  /** The product's page on techspecs.ui.com; empty until a poll has seen its category. */
  techspecs_url: string
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
  /** price_cents plus the store's surcharges; the same as price_cents when it had none. */
  price_with_surcharges_cents: number | null
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

/** How many products have something collected, and how many don't (see GET /v1/status). */
export interface Presence {
  with: number
  without: number
  /** Among `without`: nothing has been fetched for them yet, so they may only be lacking it for now. */
  not_checked: number
}

export interface StatusCategory {
  region: string
  /** The store's category id (e.g. "physical-security-nvr"). */
  id: string
  products: number
}

export interface StatusResponse {
  now: string
  products: number
  variants: number
  /** When the newest variant was last checked; null before the first poll. */
  last_sync: string | null
  /** When the variant checked longest ago was checked. */
  oldest_check: string | null
  /** When the poller last finished a pass; null until one has since the server started. */
  last_poll: string | null
  regions: Record<string, number>
  categories: StatusCategory[]
  /** Products not in any of the categories above (category not learned yet). */
  uncategorized: number
  specs: Presence
  techspecs_url: Presence
  /** Products whose own page hasn't been read yet. */
  never_detailed: number
  variants_by_status: Record<string, number>
  watched_from_config: number
  watched_from_ui: number
  pending_items: number
  events_24h: number
  events_7d: number
  pending_events: number
  failed_events: number
  latest_event: string | null
  db_bytes: number | null
}
