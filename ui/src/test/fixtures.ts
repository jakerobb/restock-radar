import type { Derived, HistoryResponse, Port, Product, ProductsResponse, Variant } from '../api/types'

export function variant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: 'v1',
    num: 1,
    sku: 'SKU-1',
    title: 'Black',
    status: 'Available',
    price_cents: 10900,
    regular_price_cents: null,
    price_with_surcharges_cents: null,
    surcharge_types: [],
    currency: 'USD',
    last_checked: new Date().toISOString(),
    last_changed: new Date().toISOString(),
    first_seen: new Date().toISOString(),
    ...overrides,
  }
}

export function product(overrides: Partial<Product> = {}): Product {
  return {
    region: 'us',
    id: 'p1',
    slug: 'widget',
    title: 'Widget',
    type: '',
    category: '',
    tags: [],
    collection: '',
    short_title: '',
    group: '',
    url: 'https://store.example/us/en/products/widget',
    techspecs_url: 'https://techspecs.ui.com/unifi/switching/widget',
    variants: [variant()],
    ...overrides,
  }
}

export function productsResponse(overrides: Partial<ProductsResponse> = {}): ProductsResponse {
  return { last_sync: new Date().toISOString(), regions: ['us'], products: [product()], pending: [], ...overrides }
}

export function historyResponse(overrides: Partial<HistoryResponse> = {}): HistoryResponse {
  const until = Date.now()
  return {
    since: new Date(until - 30 * 86_400_000).toISOString(),
    until: new Date(until).toISOString(),
    variants: [],
    ...overrides,
  }
}

export function port(overrides: Partial<Port> = {}): Port {
  return {
    label: '1 GbE RJ45',
    media: 'rj45',
    role: 'data',
    count: 8,
    max_speed_mbps: 1000,
    speeds_mbps: [1000, 100],
    poe_class: '',
    poe_direction: '',
    ...overrides,
  }
}

/** A product's derived specs with nothing known, unless the overrides say so. */
export function derived(overrides: Partial<Derived> = {}): Derived {
  return {
    region: 'us',
    product_id: 'p1',
    slug: 'widget',
    title: 'Widget',
    category: 'switching-professional',
    version: 1,
    derived_at: new Date().toISOString(),
    ports: [],
    poe_budget: [],
    poe_max_class: '',
    radios: [],
    power: [],
    metrics: [],
    rack: { mountable: false, units: 0, full_depth: false },
    dims: { min_mm: 0, mid_mm: 0, max_mm: 0 },
    known: { ports: false, poe: false, radios: false, rack: false, dims: false },
    issues: [],
    overridden: { ports: false, poe_budget: false, radios: false, rack: false, dims: false, metrics: [] },
    ...overrides,
  }
}

/** What the browser has stored for the plan being edited: `lines` as the texts kept, or its `hosting`, `powering` or `name`. */
export function stored(part: 'lines' | 'hosting' | 'powering' | 'name'): unknown {
  const raw = JSON.parse(localStorage.getItem('restock-radar.plans')!) as { active: string; plans: { id: string; name: string; lines: string[]; hosting: unknown; powering: unknown }[] }
  return raw.plans.find((p) => p.id === raw.active)![part]
}
