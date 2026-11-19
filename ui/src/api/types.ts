// The shapes served by the Go API (src/internal/api/products.go).

export interface Variant {
  id: string
  /** A permanent small number for the variant; it identifies the region, product and variant in shared build-plan links. */
  num: number
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
  /** Variants the store has taken off the product, so a plan link made while they were listed still resolves (to the variant with the same SKU, if any). */
  retired?: { num: number; sku: string }[]
  /** Products (in this region) the store sells with this one, such as a gateway's SSDs, in the store's order, and what its page calls each choice ("2 TB") when it says. */
  linked?: { slug: string; label?: string }[]
  /** What the store's page calls having none of them ("No Storage"), when it says. */
  linked_none?: string
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

// ---- Specifications (src/internal/specs, GET /v1/derived and /v1/products/{region}/{slug}/specs) ----

export interface Port {
  label: string
  /** "rj45", "sfp", "sfp+", "sfp28", "qsfp28", ... or "other". */
  media: string
  /** "data", "console", "mgmt", "sma" or "stacking". */
  role: string
  count: number
  /** Zero when the store doesn't say. */
  max_speed_mbps: number
  speeds_mbps: number[]
  /** "PoE", "PoE+", "PoE++" or "PoE+++"; empty for a port with no PoE. */
  poe_class: string
  /** "out" (powers what is plugged in), "in" (the device is powered through it), or empty. */
  poe_direction: string
  poe_inferred?: boolean
  poe_watts?: number | null
  /** Shares its position with another port (a combo RJ45/SFP+ pair), so only one of the two is usable at a time. */
  combo?: boolean
}

export interface PoEScenario {
  name: string
  watts: number
  /** The figure used as the device's budget. */
  selected: boolean
}

export interface Radio {
  /** "2.4 GHz", "5 GHz", "6 GHz", "60 GHz", "Bluetooth" or "SuperLink". */
  band: string
  /** "wifi", "wigig", "bluetooth" or "superlink". */
  tech: string
  antenna_gain_dbi: number | null
  tx_power_dbm: number | null
  tx_power_extended_dbm?: number | null
  streams: number | null
  max_rate_mbps: number | null
  multi?: boolean
  antenna_gain_raw?: string
  tx_power_raw?: string
  tx_power_note?: string
  mimo_raw?: string
}

export interface Metric {
  name: string
  value: number
  unit: string
  /** Published as "N+". */
  at_least: boolean
  /** The text the number came from. */
  raw: string
}

export interface Rack {
  mountable: boolean
  units: number
  full_depth: boolean
}

export interface Dims {
  min_mm: number
  mid_mm: number
  max_mm: number
  round?: boolean
  width_mm?: number | null
  depth_mm?: number | null
  height_mm?: number | null
}

/** Which kinds of fact could be derived at all; "not known" is not "none". */
export interface Known {
  ports: boolean
  poe: boolean
  radios: boolean
  rack: boolean
  dims: boolean
}

export interface SpecIssue {
  area: string
  label: string
  value: string
  problem: string
}

export interface OverriddenMetric {
  name: string
  published: Metric | null
}

export interface Overridden {
  ports: boolean
  poe_budget: boolean
  radios: boolean
  rack: boolean
  dims: boolean
  metrics: OverriddenMetric[]
}

export type PowerKind = 'poe' | 'passive_poe' | 'ac' | 'dc' | 'usb' | 'battery' | 'rps' | 'other'

export interface PowerSource {
  kind: PowerKind
  /** For kind 'poe': the lowest PoE class that powers it. */
  poe_class: string
  /** The line of the specification it was read from. */
  detail: string
}

export interface Derived {
  region: string
  product_id: string
  slug: string
  title: string
  category: string
  version: number
  derived_at: string
  ports: Port[]
  poe_budget: PoEScenario[]
  poe_max_class: string
  radios: Radio[]
  /** The ways it can be powered; empty when the specification doesn't say. */
  power: PowerSource[]
  metrics: Metric[]
  rack: Rack
  dims: Dims
  known: Known
  issues: SpecIssue[]
  overridden: Overridden
}

/** One entry of a product's effective specification. */
export interface SpecEntry {
  section_id: string
  section: string
  /** "Standard", or "Overview" for the store's grid summary (which repeats entries of other sections). */
  section_type: string
  feature_id: string
  parent_id?: string
  label: string
  /** "text", "flag" or "group". */
  kind: string
  value?: string
  note?: string
  /** "published", "override" or "added". */
  origin: string
  /** What the store published, when an override replaced it. */
  published_value?: string
  override_id?: number
  /** The store's published value has changed since the override was made. */
  stale?: boolean
}

export interface SpecOverride {
  id: number
  region: string
  slug: string
  /** "set" or "hide". */
  action: string
  section: string
  group: string
  label: string
  kind: string
  value: string
  note: string
  source_url: string
  reason: string
  /** What the override does to the specification now: "overrides", "hides", "adds", "orphan" or "unknown_product". */
  status: string
  stale: boolean
  published_now: string | null
  /** What the store published when the override was made; null for an added entry. */
  published_value?: string | null
  created_at?: string
  updated_at?: string
  /** Who made and last changed it; only sent to those who may review overrides. */
  created_by?: string
  updated_by?: string
}

export interface ProductSpecsResponse {
  region: string
  id: string
  slug: string
  title: string
  category: string
  specs: SpecEntry[]
  overrides: SpecOverride[]
  /** Null for a product with nothing to derive from. */
  derived: Derived | null
}

/** What POST /v1/products/{region}/{slug}/refresh found. */
export interface RefreshResult {
  region: string
  slug: string
  title: string
  variants: number
  /** How many specification entries the store published. */
  spec_entries: number
  /** The stored specification differs from before, so what is derived from it was rebuilt. */
  specs_changed: boolean
  /** Changes (price, stock) the fetch turned up; they are announced by the next poll. */
  events: number
}

// ---- Who may do what (GET /v1/me) ----

export type Permission = 'overrides:write' | 'watchlist:write' | 'products:refresh'

export interface Me {
  /** How identity is decided: "open" (nobody is asked), "proxy", or "closed" (misconfigured: nothing may change). */
  mode: 'open' | 'proxy' | 'closed'
  authenticated: boolean
  open: boolean
  user?: string
  name?: string
  email?: string
  roles: string[]
  permissions: Permission[]
}

// ---- Overrides (PUT /v1/overrides, GET /v1/overrides/history) ----

export interface OverrideRequest {
  region: string
  slug: string
  action: 'set' | 'hide'
  section: string
  group?: string
  label: string
  kind?: 'text' | 'flag'
  value?: string
  note?: string
  source_url?: string
  reason?: string
}

export interface OverrideChange {
  id: number
  at: string
  actor: string
  change: 'create' | 'update' | 'delete'
  override_id: number
  region: string
  slug: string
  /** The override as it was; null for a creation. */
  before: SpecOverride | null
  /** The override as it became; null for a deletion. */
  after: SpecOverride | null
}
