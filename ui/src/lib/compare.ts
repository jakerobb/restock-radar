import type { Product, Radio } from '../api/types'
import { columnById, type CatalogRow, type Column } from './catalog'
import { formatPrice, formatRelative, onSale } from './format'

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

/** The Wi-Fi bands compared one by one; any other radio (Bluetooth, 60 GHz, SuperLink) goes in the summary. */
const WIFI_BANDS = ['2.4 GHz', '5 GHz', '6 GHz']

const isBandRadio = (x: Radio): boolean => x.tech === 'wifi' && WIFI_BANDS.includes(x.band)

/** A product's biggest value for a band's radios (a band can be listed twice, as in a dual-5 GHz AP); null when unknown. */
const bandNumber = (r: CatalogRow, band: string, pick: (x: Radio) => number | null): number | null => {
  const values = (r.derived?.radios ?? []).filter((x) => x.band === band).map(pick).filter((n): n is number => n !== null && n > 0)
  return values.length > 0 ? Math.max(...values) : null
}

const mbps = (v: number): string => (v >= 1000 ? `${Number((v / 1000).toFixed(2))} Gbps` : `${v} Mbps`)

/** The per-band lines (TX power, gain, data rate, streams) for each Wi-Fi band at least one product has. */
function bandLines(rows: CatalogRow[]): CompareLine[] {
  const measures: { id: string; label: string; pick: (x: Radio) => number | null; show: (n: number) => string }[] = [
    { id: 'tx', label: 'TX power', pick: (x) => x.tx_power_dbm, show: (n) => `${n} dBm` },
    { id: 'gain', label: 'antenna gain', pick: (x) => x.antenna_gain_dbi, show: (n) => `${n} dBi` },
    { id: 'rate', label: 'max data rate', pick: (x) => x.max_rate_mbps, show: mbps },
    { id: 'streams', label: 'streams', pick: (x) => x.streams, show: String },
  ]
  return WIFI_BANDS.flatMap((band) => {
    if (!rows.some((r) => r.derived?.radios.some((x) => x.band === band))) return []
    return measures.flatMap((m) => {
      const numbers = rows.map((r) => bandNumber(r, band, m.pick))
      const cells = rows.map((r, i) => {
        if (numbers[i] !== null) return [m.show(numbers[i]!)]
        if (!r.derived?.known.radios) return null
        // Known to have no such radio, or the radio is there but the store doesn't say.
        return r.derived.radios.some((x) => x.band === band) ? null : ['none']
      })
      return cells.every((c) => c === null) ? [] : [line(`${band}_${m.id}`, `${band} ${m.label}`, cells, numbers)]
    })
  })
}

const radioLines = (r: CatalogRow): string[] | null => {
  const d = r.derived
  if (!d?.known.radios) return null
  const others = d.radios.filter((x) => !isBandRadio(x))
  if (others.length === 0) return ['none']
  return others.map(
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

/** The sale on the variant behind the price: "20% off, was $349"; "none" when it isn't on sale. */
const saleLines = (r: CatalogRow): string[] | null => {
  const v = r.price.variant
  if (!v) return null
  if (!onSale(v)) return ['none']
  const off = Math.round(((v.regular_price_cents! - v.price_cents!) / v.regular_price_cents!) * 100)
  return [`${off}% off, was ${formatPrice(v.regular_price_cents, v.currency)}`]
}

/** The store's own words for a change to the price or its surcharges; a stock change says nothing about price. */
const isPriceChange = (what: string): boolean => /^price|surcharge/i.test(what)

const NO_RECENT_CHANGE = 'no recent change'

/** What the price last did, and when, if the variant's latest change was to its price. */
const priceChangeLines = (r: CatalogRow): string[] | null => {
  const v = r.price.variant
  if (!v) return null
  if (!v.last_change || !isPriceChange(v.last_change)) return [NO_RECENT_CHANGE]
  return [`${v.last_change} ${formatRelative(v.last_changed)}`]
}

/** Leaves out a line nobody has anything to say about (a row of nothing but "none"). */
const informative = (l: CompareLine | null): l is CompareLine => l !== null && l.cells.some((c) => c !== null && !(c.length === 1 && (c[0] === 'none' || c[0] === NO_RECENT_CHANGE)))

/**
 * Lines up the products' prices, derived numbers, ports, radios and size for a side-by-side view. A line
 * appears only when at least one product has something for it, so a switch comparison has no radios.
 */
export function buildComparison(rows: CatalogRow[]): CompareSection[] {
  // A price nobody can pay now (last seen) isn't one to beat.
  const prices = rows.map((r) => (r.price.buyable ? r.price.cents : null))
  const sections: CompareSection[] = [
    {
      title: 'Price and stock',
      lines: [
        line('price', 'Price', rows.map((r) => (r.price.cents === null ? null : [formatPrice(r.price.cents, r.price.currency) + (r.price.buyable ? '' : ' (last seen)')])), prices, true),
        ...[line('sale', 'Sale', rows.map(saleLines)), line('price_change', 'Latest price change', rows.map(priceChangeLines))].filter(informative),
        line('stock', 'Stock', rows.map((r) => [stockText(r)])),
      ],
    },
    { title: 'Value', lines: columns(['per_poe_w', 'per_poe_port', 'per_10g_port', 'per_gbps', 'per_sqft'], rows) },
    { title: 'Performance and power', lines: columns(['power', 'poe_budget_w', 'power_draw_max_w', 'power_draw_excl_poe_w', 'switching_capacity_gbps', 'nonblocking_throughput_gbps', 'forwarding_rate_mpps', 'ids_ips_throughput_mbps'], rows) },
    {
      title: 'Ports',
      lines: [...columns(['fastest_port', 'ports', 'poe_out_ports', 'poe_class'], rows), line('port_layout', 'Port layout', rows.map(portLines))].filter(informative),
    },
    {
      title: 'Wireless',
      lines: [...columns(['wifi_generation', 'coverage_sqft', 'coverage_m2', 'range_m'], rows), ...bandLines(rows), line('radios', 'Other radios', rows.map(radioLines))].filter(informative),
    },
    {
      title: 'Physical',
      lines: [...columns(['rack_u'], rows), line('rack', 'Mounting', rows.map(rackLine)), line('dims', 'Dimensions', rows.map(dimsLine))].filter(informative),
    },
  ]
  return sections.filter((s) => s.lines.length > 0)
}
