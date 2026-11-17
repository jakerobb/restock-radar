import type { Product } from '../api/types'
import { columnById, type CatalogRow, type Column } from './catalog'
import { formatPrice } from './format'

/** How many products fit side by side. */
export const MAX_COMPARE = 4

/** A product's name in the URL: "us/usw-pro-max-24-poe". */
export const productRef = (p: Pick<Product, 'region' | 'slug'>): string => `${p.region}/${p.slug}`

/** Keeps the well-formed references, once each, up to the limit. */
export function cleanRefs(list: string[]): string[] {
  const ok = list.filter((r) => /^[^/\s]+\/[^/\s]+$/.test(r))
  return [...new Set(ok)].slice(0, MAX_COMPARE)
}

/** One row of the comparison: what each product has for it. */
export interface CompareLine {
  id: string
  label: string
  /** Per product, the lines of text to show, or null when it isn't known. */
  cells: (string[] | null)[]
  /** Per product, true where its number beats the others'. Only set for numbers that differ. */
  best: boolean[]
  /** True unless every product reads the same (unknown counts as different from known). */
  differs: boolean
}

export interface CompareSection {
  title: string
  lines: CompareLine[]
}

function line(id: string, label: string, cells: (string[] | null)[], numbers?: (number | null)[], lowerIsBetter = false): CompareLine {
  const key = (c: string[] | null) => (c === null ? '?' : c.join('\n'))
  const differs = new Set(cells.map(key)).size > 1
  let best = cells.map(() => false)
  const known = numbers?.filter((n): n is number => n !== null) ?? []
  if (numbers && known.length >= 2 && new Set(known).size > 1) {
    const top = lowerIsBetter ? Math.min(...known) : Math.max(...known)
    best = numbers.map((n) => n === top)
  }
  return { id, label, cells, best, differs }
}

/** A line from one of the finder's columns; null when no product has a value for it. */
function fromColumn(c: Column, rows: CatalogRow[]): CompareLine | null {
  const values = rows.map((r) => c.value(r))
  if (values.every((v) => v === null)) return null
  const cells = values.map((v, i) => (v === null ? null : [c.format(v, rows[i])]))
  const numbers = values.map((v) => (typeof v === 'number' ? v : null))
  return line(c.id, c.label, cells, numbers, c.lowerIsBetter)
}

function columns(ids: string[], rows: CatalogRow[]): CompareLine[] {
  return ids.flatMap((id) => {
    const c = columnById(id)
    const l = c ? fromColumn(c, rows) : null
    return l ? [l] : []
  })
}

const portLines = (r: CatalogRow): string[] | null => {
  const d = r.derived
  if (!d?.known.ports) return null
  const lines = d.ports
    .filter((p) => p.role === 'data')
    .map((p) => `${p.count} × ${p.label}${p.poe_class ? ` · ${p.poe_class}${p.poe_direction ? ` ${p.poe_direction}` : ''}` : ''}`)
  return lines.length > 0 ? lines : ['none']
}

const radioLines = (r: CatalogRow): string[] | null => {
  const d = r.derived
  if (!d?.known.radios) return null
  if (d.radios.length === 0) return ['none']
  return d.radios.map(
    (x) => [x.band, x.streams !== null && `${x.streams} streams`, x.tx_power_dbm !== null && `${x.tx_power_dbm} dBm TX`, x.antenna_gain_dbi !== null && `${x.antenna_gain_dbi} dBi`].filter(Boolean).join(' · '),
  )
}

const dimsLine = (r: CatalogRow): string[] | null => {
  const d = r.derived
  return d?.known.dims && d.dims.max_mm > 0 ? [`${d.dims.min_mm} × ${d.dims.mid_mm} × ${d.dims.max_mm} mm`] : null
}

const rackLine = (r: CatalogRow): string[] | null => {
  const d = r.derived
  if (!d?.known.rack) return null
  return [d.rack.mountable ? `Rack-mount${d.rack.units ? `, ${d.rack.units}U` : ''}` : 'Not rack-mount']
}

const stockText = (r: CatalogRow): string => {
  const { stock, inStock, variants } = r.price
  if (stock === 'in') return variants > 1 ? `${inStock} of ${variants} in stock` : 'In stock'
  return stock === 'soon' ? 'Coming soon' : 'Sold out'
}

/** Leaves out a line nobody has anything to say about (a row of nothing but "none"). */
const informative = (l: CompareLine | null): l is CompareLine => l !== null && l.cells.some((c) => c !== null && !(c.length === 1 && c[0] === 'none'))

/**
 * Lines up the products' prices, derived numbers, ports, radios and size for a side-by-side view. A line
 * appears only when at least one product has something for it, so a switch comparison has no radios.
 */
export function buildComparison(rows: CatalogRow[]): CompareSection[] {
  const prices = rows.map((r) => r.price.cents)
  const sections: CompareSection[] = [
    {
      title: 'Price and stock',
      lines: [
        line('price', 'Price', rows.map((r) => (r.price.cents === null ? null : [formatPrice(r.price.cents, r.price.currency) + (r.price.buyable ? '' : ' (last seen)')])), prices, true),
        line('stock', 'Stock', rows.map((r) => [stockText(r)])),
      ],
    },
    { title: 'Value', lines: columns(['per_poe_w', 'per_poe_port', 'per_10g_port', 'per_gbps', 'per_sqft'], rows) },
    { title: 'Performance and power', lines: columns(['poe_budget_w', 'power_draw_max_w', 'power_draw_excl_poe_w', 'switching_capacity_gbps', 'nonblocking_throughput_gbps', 'forwarding_rate_mpps', 'ids_ips_throughput_mbps'], rows) },
    {
      title: 'Ports',
      lines: [...columns(['fastest_port', 'ports', 'poe_out_ports', 'poe_class'], rows), line('port_layout', 'Port layout', rows.map(portLines))].filter(informative),
    },
    {
      title: 'Wireless',
      lines: [...columns(['wifi_generation', 'coverage_sqft', 'coverage_m2', 'range_m', 'tx_6ghz', 'max_gain'], rows), line('radios', 'Radios', rows.map(radioLines))].filter(informative),
    },
    {
      title: 'Physical',
      lines: [...columns(['rack_u'], rows), line('rack', 'Mounting', rows.map(rackLine)), line('dims', 'Dimensions', rows.map(dimsLine))].filter(informative),
    },
  ]
  return sections.filter((s) => s.lines.length > 0)
}
