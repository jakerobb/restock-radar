import type { Derived, Product } from '../api/types'
import { buildCatalog } from './catalog'
import { acceptsRow, idsSteps, mountsFor, NO_FILTERS, withMounts, type FinderFilters } from './finderFilters'
import { derived, product, variant } from '../test/fixtures'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
const flag = (name: string, value = 1) => ({ name, value, unit: '', at_least: false, raw: '' })
const rate = (mbps: number) => ({ name: 'ids_ips_throughput_mbps', value: mbps, unit: 'Mbps', at_least: false, raw: '' })
const rackOf = (mountable: boolean, units = 1) => ({ mountable, units, full_depth: false })

function setup(specs: { slug: string; type: string; cents?: number; status?: 'Available' | 'SoldOut'; d: Partial<Derived> }[]) {
  const products: Product[] = specs.map((s, i) => product({ id: s.slug, slug: s.slug, title: s.slug, type: s.type, variants: [variant({ id: s.slug, num: i + 1, sku: s.slug.toUpperCase(), price_cents: s.cents ?? 10000, status: s.status ?? 'Available' })] }))
  const rows = buildCatalog(products, specs.map((s) => derived({ slug: s.slug, known, ...s.d })))
  return { rows, map: new Map(products.map((p) => [`${p.region}/${p.slug}`, p])), row: (slug: string) => rows.find((r) => r.product.slug === slug)! }
}
const on = (over: Partial<FinderFilters>): FinderFilters => ({ ...NO_FILTERS, ...over })

describe('finder filters', () => {
  const s = setup([
    { slug: 'beast', type: 'Gateways', d: { rack: rackOf(true, 2), metrics: [rate(25000), flag('shadow_mode'), flag('hot_swap_psu')] } },
    { slug: 'fiber', type: 'Gateways', d: { rack: rackOf(false), metrics: [rate(5000), flag('pppoe_acceleration')] } },
    { slug: 'ultra', type: 'Gateways', d: { rack: rackOf(false), metrics: [rate(1000)] } },
    { slug: 'ucg-industrial', type: 'Gateways', d: { rack: rackOf(true, 0), metrics: [rate(5000)] } },
    { slug: 'uacc-ucg-industrial-rm', type: 'Accessories', d: {} },
    { slug: 'cloudkey', type: 'Accessories', d: { known: { ...known, rack: false } } },
  ])
  const pass = (f: FinderFilters) => s.rows.filter((r) => acceptsRow(r, f, s.map)).map((r) => r.product.slug)

  it('passes everything with no filter', () => {
    expect(pass(NO_FILTERS)).toHaveLength(6)
  })

  it('narrows gateways by IDS/IPS throughput, shadow mode and PPPoE acceleration, which only a published or overridden fact shows', () => {
    expect(pass(on({ minIdsMbps: 5000 })).filter((x) => x !== 'uacc-ucg-industrial-rm' && x !== 'cloudkey')).toEqual(['beast', 'fiber', 'ucg-industrial'])
    expect(pass(on({ shadow: true })).filter((x) => x !== 'uacc-ucg-industrial-rm' && x !== 'cloudkey')).toEqual(['beast'])
    expect(pass(on({ pppoe: true })).includes('ultra')).toBe(false) // nothing says it has it, so it isn't taken to
    expect(pass(on({ pppoe: true })).includes('fiber')).toBe(true)
  })

  it('leaves the gateway filters to gateways, so a controller sold beside one is not ruled out by them', () => {
    expect(pass(on({ pppoe: true }))).toContain('cloudkey')
  })

  it('wants a hot-swappable power supply stated', () => {
    expect(pass(on({ hotSwap: true }))).toEqual(['beast'])
  })

  it('splits rackmount from not, putting a device that goes in a rack with an accessory on both sides', () => {
    // The Industrial gateway is rack-mount only with its accessory (which is on sale here); the unknown is neither.
    expect(pass(on({ rack: 'rack' }))).toEqual(['beast', 'ucg-industrial'])
    expect(pass(on({ rack: 'desk' }))).toEqual(['fiber', 'ultra', 'ucg-industrial', 'uacc-ucg-industrial-rm'])
  })

  it('has no accessory for a device that needs one when the store has none on sale', () => {
    const lone = setup([{ slug: 'ucg-industrial', type: 'Gateways', d: { rack: rackOf(true, 0), metrics: [rate(5000)] } }])
    expect(acceptsRow(lone.row('ucg-industrial'), on({ rack: 'rack' }), lone.map)).toBe(false)
    expect(acceptsRow(lone.row('ucg-industrial'), on({ rack: 'desk' }), lone.map)).toBe(true)
  })

  it('adds the accessory for what a rack filter finds that needs one, one for each of a device, or a share of one that holds several', () => {
    const m = mountsFor(s.row('ucg-industrial'), 2, on({ rack: 'rack' }), s.map)
    expect(m.map((x) => [x.product.slug, x.qty, x.cents])).toEqual([['uacc-ucg-industrial-rm', 2, 20000]])
    expect(mountsFor(s.row('ucg-industrial'), 2, NO_FILTERS, s.map)).toEqual([])
    expect(mountsFor(s.row('beast'), 1, on({ rack: 'rack' }), s.map)).toEqual([]) // made for a rack
    expect(withMounts(30000, true, m)).toEqual({ cents: 50000, inStock: true })
  })

  it('offers the throughputs in the catalogue, smallest first', () => {
    expect(idsSteps(s.rows)).toEqual([1000, 5000, 25000])
  })
})
