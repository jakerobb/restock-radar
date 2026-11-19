import type { Product } from '../api/types'
import type { CatalogRow } from './catalog'
import { lineFor, viewLine, type PlanLine } from './plan'
import { NEEDS_RACK_MOUNT, RACK_MOUNTS } from './rackMounts'
import { isGatewayProduct } from './roles'

/** What the plan's product finders can be narrowed to. */
export interface FinderFilters {
  /** 'rack': made for a rack, with the accessory that mounts it where it needs one; 'desk': not rack-mount. */
  rack: 'any' | 'rack' | 'desk'
  /** Only what can be bought now: in stock, with the accessory that mounts it where it needs one. */
  inStock: boolean
  /** Power supplies that can be changed with the device running (CRPS). */
  hotSwap: boolean
  /** Gateways only: hardware PPPoE acceleration, which the store doesn't publish, so only where an override says so. */
  pppoe: boolean
  /** Gateways only: shadow mode (a VRRP pair that fails over). */
  shadow: boolean
  /** Gateways only: at least this much IDS/IPS throughput, in Mbps; 0 for any. */
  minIdsMbps: number
}

export const NO_FILTERS: FinderFilters = { inStock: false, rack: 'any', hotSwap: false, pppoe: false, shadow: false, minIdsMbps: 0 }

/** True when any filter narrows anything. */
export const isFiltering = (f: FinderFilters): boolean => f.inStock || f.rack !== 'any' || f.hotSwap || f.pppoe || f.shadow || f.minIdsMbps > 0

const metric = (r: CatalogRow, name: string): number => {
  const v = r.derived?.metrics.find((m) => m.name === name)?.value
  return typeof v === 'number' ? v : 0
}

/** The rack-mount accessory for each product that needs one, by the product's slug. */
const MOUNT_OF: Record<string, { slug: string; capacity: number }> = Object.fromEntries(
  Object.entries(RACK_MOUNTS).flatMap(([slug, m]) => m.fits.map((fit) => [fit, { slug, capacity: m.capacity }] as const)),
)

/** A rack-mount accessory to buy with a device, which goes in the plan beside it. */
export interface Mount {
  product: Product
  qty: number
  cents: number | null
  inStock: boolean
}

/** What a device is for a rack: made for one, in need of an accessory to go in one (and that accessory is on sale here), or not for one. Null when the store doesn't say. */
function rackKind(row: CatalogRow, products: Map<string, Product>): 'rack' | 'rack-with-mount' | 'desk' | null {
  const need = NEEDS_RACK_MOUNT.has(row.product.slug) ? MOUNT_OF[row.product.slug] : undefined
  if (need) return products.has(`${row.product.region}/${need.slug}`) ? 'rack-with-mount' : 'desk'
  if (!row.derived?.known.rack) return null
  return row.derived.rack.mountable ? 'rack' : 'desk'
}

/** Whether a product passes the filters that don't depend on how many are bought. A property nothing states isn't taken to be there. */
export function acceptsRow(row: CatalogRow, f: FinderFilters, products: Map<string, Product>): boolean {
  if (f.inStock && row.price.stock !== 'in') return false
  if (f.hotSwap && metric(row, 'hot_swap_psu') < 1) return false
  if (f.rack !== 'any') {
    const kind = rackKind(row, products)
    if (f.rack === 'rack' ? kind !== 'rack' && kind !== 'rack-with-mount' : kind !== 'desk' && kind !== 'rack-with-mount') return false
  }
  // The rest are about the gateway: a Cloud Key sold beside one has none of it to say.
  if (isGatewayProduct(row.product, row.derived)) {
    if (f.pppoe && metric(row, 'pppoe_acceleration') < 1) return false
    if (f.shadow && metric(row, 'shadow_mode') < 1) return false
    if (f.minIdsMbps > 0 && metric(row, 'ids_ips_throughput_mbps') < f.minIdsMbps) return false
  }
  return true
}

/** The accessories that mount `qty` of a device, when the rack filter is on and the device needs one; none otherwise. */
export function mountsFor(row: CatalogRow, qty: number, f: FinderFilters, products: Map<string, Product>): Mount[] {
  if (f.rack !== 'rack') return []
  const need = NEEDS_RACK_MOUNT.has(row.product.slug) ? MOUNT_OF[row.product.slug] : undefined
  const product = need && products.get(`${row.product.region}/${need.slug}`)
  if (!need || !product) return []
  const n = Math.ceil(qty / need.capacity)
  const line = lineFor(product, n)
  if (!line) return []
  const view = viewLine(line, products)
  return [{ product, qty: n, cents: view.totalCents, inStock: view.state === 'in' }]
}

/** The plan lines for those accessories. */
export const mountLines = (mounts: Mount[]): PlanLine[] => mounts.flatMap((m) => lineFor(m.product, m.qty) ?? [])

/** What mounts add to a price (null when one has none shown) and whether all are in stock. */
export function withMounts(cents: number | null, inStock: boolean, mounts: Mount[]): { cents: number | null; inStock: boolean } {
  return {
    cents: mounts.reduce<number | null>((n, m) => (n === null || m.cents === null ? null : n + m.cents), cents),
    inStock: inStock && mounts.every((m) => m.inStock),
  }
}

/** The IDS/IPS throughputs on offer (Mbps), smallest first, from the catalogue itself. */
export function idsSteps(rows: CatalogRow[]): number[] {
  return [...new Set(rows.filter((r) => isGatewayProduct(r.product, r.derived)).map((r) => metric(r, 'ids_ips_throughput_mbps')).filter((v) => v > 0))].sort((a, b) => a - b)
}
