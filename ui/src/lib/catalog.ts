import type { Derived, Product } from '../api/types'
import { totalCents } from './format'
import { metricInfo } from './requirements'

export type StockState = 'in' | 'soon' | 'out'

/** What a product costs and whether it can be had, summarised over its variants. */
export interface PriceSummary {
  /** The cheapest in-stock variant's out-the-door price; with nothing in stock, the cheapest price seen. Null when no variant has a price. */
  cents: number | null
  currency: string
  stock: StockState
  /** True when `cents` is the price of a variant that can be bought now. */
  buyable: boolean
  inStock: number
  variants: number
}

/** One product with what is derived from its specification (null when nothing is). */
export interface CatalogRow {
  product: Product
  derived: Derived | null
  price: PriceSummary
}

export function summarizePrice(p: Product): PriceSummary {
  const priced = p.variants.map((v) => ({ v, cents: totalCents(v) })).filter((x): x is { v: Product['variants'][number]; cents: number } => x.cents !== null)
  const cheapest = (xs: typeof priced) => xs.reduce<(typeof priced)[number] | undefined>((a, b) => (a === undefined || b.cents < a.cents ? b : a), undefined)
  const available = priced.filter((x) => x.v.status === 'Available')
  const pick = cheapest(available) ?? cheapest(priced)
  const inStock = p.variants.filter((v) => v.status === 'Available').length
  const stock: StockState = inStock > 0 ? 'in' : p.variants.some((v) => v.status === 'ComingSoon') ? 'soon' : 'out'
  return {
    cents: pick?.cents ?? null,
    currency: pick?.v.currency ?? p.variants[0]?.currency ?? 'USD',
    stock,
    buyable: available.length > 0,
    inStock,
    variants: p.variants.length,
  }
}

/** Joins the products (as tracked, not merged: each has its own specification) with their derived specs. */
export function buildCatalog(products: Product[], derived: Derived[]): CatalogRow[] {
  const byKey = new Map(derived.map((d) => [`${d.region}/${d.slug}`, d]))
  return products.map((product) => ({ product, derived: byKey.get(`${product.region}/${product.slug}`) ?? null, price: summarizePrice(product) }))
}

// ---- Columns ----

export interface Column {
  id: string
  label: string
  /** The sortable value; null when unknown. Strings sort alphabetically. */
  value: (r: CatalogRow) => number | string | null
  /** The cell text for a non-null value. */
  format: (v: number | string) => string
  /** True when a smaller value is better, so the first sort click goes ascending. */
  lowerIsBetter?: boolean
}

const plain = (v: number | string) => String(v)
const withUnit = (unit: string) => (v: number | string) => `${v}${unit ? ` ${unit}` : ''}`

const metricValue = (name: string) => (r: CatalogRow) => r.derived?.metrics.find((m) => m.name === name)?.value ?? null

const dataPorts = (r: CatalogRow) => (r.derived?.known.ports ? r.derived.ports.filter((p) => p.role === 'data') : null)

const fromMetric = (name: string): Column => {
  const info = metricInfo(name)!
  return { id: name, label: info.label, value: metricValue(name), format: withUnit(info.unit), lowerIsBetter: info.lowerIsBetter }
}

/** The extra columns the table can show (price and stock are always there). */
export const COLUMNS: readonly Column[] = [
  fromMetric('poe_budget_w'),
  fromMetric('power_draw_max_w'),
  fromMetric('power_draw_excl_poe_w'),
  fromMetric('switching_capacity_gbps'),
  fromMetric('nonblocking_throughput_gbps'),
  fromMetric('forwarding_rate_mpps'),
  fromMetric('ids_ips_throughput_mbps'),
  fromMetric('wifi_generation'),
  {
    id: 'fastest_port',
    label: 'Fastest port',
    value: (r) => {
      const ports = dataPorts(r)
      if (!ports || ports.length === 0) return null
      const best = Math.max(...ports.map((p) => p.max_speed_mbps))
      return best > 0 ? best : null
    },
    format: (v) => (Number(v) >= 1000 ? `${Number(v) / 1000} GbE` : `${v} Mbps`),
  },
  {
    id: 'ports',
    label: 'Data ports',
    value: (r) => dataPorts(r)?.reduce((n, p) => n + p.count, 0) ?? null,
    format: plain,
  },
  {
    id: 'poe_out_ports',
    label: 'PoE out ports',
    value: (r) => dataPorts(r)?.filter((p) => p.poe_class && p.poe_direction === 'out').reduce((n, p) => n + p.count, 0) ?? null,
    format: plain,
  },
  { id: 'poe_class', label: 'Max PoE class', value: (r) => (r.derived?.known.poe ? r.derived.poe_max_class || null : null), format: plain },
  { id: 'rack_u', label: 'Rack units', value: (r) => (r.derived?.rack.mountable && r.derived.rack.units > 0 ? r.derived.rack.units : null), format: (v) => `${v}U`, lowerIsBetter: true },
  {
    id: 'tx_6ghz',
    label: '6 GHz TX power',
    value: (r) => r.derived?.radios.find((x) => x.band === '6 GHz')?.tx_power_dbm ?? null,
    format: withUnit('dBm'),
  },
  {
    id: 'max_gain',
    label: 'Antenna gain (max)',
    value: (r) => {
      const gains = r.derived?.radios.map((x) => x.antenna_gain_dbi).filter((g): g is number => g !== null) ?? []
      return gains.length > 0 ? Math.max(...gains) : null
    },
    format: withUnit('dBi'),
  },
  { id: 'size', label: 'Largest dimension', value: (r) => (r.derived?.known.dims && r.derived.dims.max_mm > 0 ? r.derived.dims.max_mm : null), format: withUnit('mm'), lowerIsBetter: true },
]

export const columnById = (id: string): Column | undefined => COLUMNS.find((c) => c.id === id)

/** Columns worth showing first for a product type. */
export function defaultColumns(type: string): string[] {
  switch (type) {
    case 'Switches':
      return ['fastest_port', 'ports', 'poe_budget_w', 'switching_capacity_gbps', 'rack_u']
    case 'WiFi':
      return ['wifi_generation', 'tx_6ghz', 'max_gain', 'power_draw_max_w']
    case 'Gateways':
      return ['fastest_port', 'ids_ips_throughput_mbps', 'power_draw_max_w', 'rack_u']
    default:
      return ['power_draw_max_w', 'poe_budget_w']
  }
}

/** The price column's sort key. */
export const PRICE_SORT = 'price'
export const NAME_SORT = 'name'

/** Sorts rows by a column (or price or name). Rows with no value go last whichever way it sorts. */
export function sortRows(rows: CatalogRow[], sort: string, dir: 'asc' | 'desc'): CatalogRow[] {
  const get = (r: CatalogRow): number | string | null => {
    if (sort === PRICE_SORT) return r.price.cents
    if (sort === NAME_SORT) return r.product.title.toLowerCase()
    return columnById(sort)?.value(r) ?? null
  }
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = get(a)
    const y = get(b)
    if (x === null && y === null) return a.product.title.localeCompare(b.product.title)
    if (x === null) return 1
    if (y === null) return -1
    const c = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y
    return c !== 0 ? sign * c : a.product.title.localeCompare(b.product.title)
  })
}
