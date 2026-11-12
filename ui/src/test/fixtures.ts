import type { HistoryResponse, Product, ProductsResponse, Variant } from '../api/types'

export function variant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: 'v1',
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
    url: 'https://store.example/us/en/products/widget',
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
