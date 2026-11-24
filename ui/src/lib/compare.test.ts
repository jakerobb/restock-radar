import { buildCatalog } from './catalog'
import { buildComparison, cleanRefs, MAX_COMPARE } from './compare'
import type { Radio } from '../api/types'
import { derived, port, product, variant } from '../test/fixtures'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
const metric = (name: string, value: number) => ({ name, value, unit: '', at_least: false, raw: '' })

const rows = () =>
  buildCatalog(
    [
      product({ slug: 'a', title: 'A', variants: [variant({ price_cents: 30000 })] }),
      product({ slug: 'b', title: 'B', variants: [variant({ price_cents: 50000, status: 'SoldOut' })] }),
    ],
    [
      derived({ slug: 'a', known, ports: [port({ count: 24 }), port({ label: '10 GbE SFP+', media: 'sfp', count: 2, max_speed_mbps: 10000 })], metrics: [metric('poe_budget_w', 200), metric('power_draw_max_w', 40)] }),
      derived({ slug: 'b', known, ports: [port({ count: 24 })], metrics: [metric('poe_budget_w', 400), metric('power_draw_max_w', 40)] }),
    ],
  )

const line = (id: string) => buildComparison(rows()).flatMap((s) => s.lines).find((l) => l.id === id)

describe('buildComparison', () => {
  it('marks the best number only where the products differ, lower or higher as suits the measure', () => {
    expect(line('price')!.best).toEqual([false, false]) // B is sold out, so its last-seen price is nothing to beat
    expect(line('poe_budget_w')!.best).toEqual([false, true]) // more wins
    expect(line('power_draw_max_w')!.best).toEqual([false, false]) // a tie crowns nobody
    expect(line('power_draw_max_w')!.differs).toBe(false)
    expect(line('poe_budget_w')!.differs).toBe(true)
  })

  it('says a price is the last one seen when nothing is in stock', () => {
    expect(line('price')!.cells).toEqual([['$300'], ['$500 (last seen)']])
    expect(line('stock')!.cells).toEqual([['In stock'], ['Sold out']])
  })

  it('lists each product’s ports, and flags the difference', () => {
    const l = line('port_layout')!
    expect(l.cells[0]).toEqual(['24 × 1 GbE RJ45', '2 × 10 GbE SFP+'])
    expect(l.cells[1]).toEqual(['24 × 1 GbE RJ45'])
    expect(l.differs).toBe(true)
  })

  it('leaves out sections and lines nobody has anything for, so switches get no radios', () => {
    const titles = buildComparison(rows()).map((s) => s.title)
    expect(titles).not.toContain('Wireless')
    expect(titles).toContain('Ports')
    expect(line('radios')).toBeUndefined()
    expect(line('coverage_sqft')).toBeUndefined()
  })

  it('treats an unknown as different from a known value, shown as null, and gives it no ranking', () => {
    const r = buildCatalog([product({ slug: 'a' }), product({ slug: 'b' })], [derived({ slug: 'a', known, ports: [port()], metrics: [metric('poe_budget_w', 100)] }), derived({ slug: 'b' })])
    const l = buildComparison(r).flatMap((s) => s.lines).find((x) => x.id === 'poe_budget_w')!
    expect(l.cells).toEqual([['100 W'], null])
    expect(l.differs).toBe(true)
    expect(l.best).toEqual([false, false]) // one number is nothing to beat
  })
})

describe('power in a comparison', () => {
  it('shows how each is powered, flags a difference, and leaves the line out when nobody says', () => {
    const power = (kind: 'ac' | 'poe', c = '') => [{ kind, poe_class: c, detail: '' }]
    const r = buildCatalog([product({ slug: 'a' }), product({ slug: 'b' })], [derived({ slug: 'a', known, power: power('ac') }), derived({ slug: 'b', known, power: power('poe', 'PoE+') })])
    const l = buildComparison(r).flatMap((s) => s.lines).find((x) => x.id === 'power')!
    expect(l.cells).toEqual([['AC'], ['PoE+']])
    expect(l.differs).toBe(true)
    expect(l.best).toEqual([false, false]) // text has no better or worse
    expect(buildComparison(rows()).flatMap((s) => s.lines).find((x) => x.id === 'power')).toBeUndefined()
  })
})

const radio = (band: string, o: Partial<Radio> = {}): Radio => ({ band, tech: 'wifi', antenna_gain_dbi: null, tx_power_dbm: null, streams: null, max_rate_mbps: null, ...o })
const lineOf = (r: ReturnType<typeof rows>, id: string) => buildComparison(r).flatMap((s) => s.lines).find((l) => l.id === id)

describe('wireless in a comparison', () => {
  const ap = (slug: string, radios: Radio[]) => derived({ slug, known, radios })
  const r = buildCatalog(
    [product({ slug: 'a' }), product({ slug: 'b' }), product({ slug: 'c' })],
    [
      ap('a', [radio('2.4 GHz', { tx_power_dbm: 22, antenna_gain_dbi: 3, max_rate_mbps: 574, streams: 2 }), radio('5 GHz', { tx_power_dbm: 26, max_rate_mbps: 4800 }), radio('6 GHz', { tx_power_dbm: 23, antenna_gain_dbi: 5, max_rate_mbps: 5700 })]),
      ap('b', [radio('2.4 GHz', { tx_power_dbm: 20, antenna_gain_dbi: 4, max_rate_mbps: 286 }), radio('5 GHz', { tx_power_dbm: 24, max_rate_mbps: 1200 }), radio('5 GHz', { tx_power_dbm: 27 }), radio('Bluetooth', { tech: 'bluetooth' })]),
      derived({ slug: 'c' }),
    ],
  )

  it('gives each band its own TX power, gain, data rate and streams', () => {
    expect(lineOf(r, '2.4 GHz_tx')!.cells).toEqual([['22 dBm'], ['20 dBm'], null])
    expect(lineOf(r, '2.4 GHz_gain')!.cells).toEqual([['3 dBi'], ['4 dBi'], null])
    expect(lineOf(r, '5 GHz_rate')!.cells).toEqual([['4.8 Gbps'], ['1.2 Gbps'], null])
    expect(lineOf(r, '2.4 GHz_rate')!.cells[0]).toEqual(['574 Mbps'])
    expect(lineOf(r, '2.4 GHz_streams')!.cells).toEqual([['2'], null, null]) // b's streams are unknown, not none
    expect(lineOf(r, '5 GHz_rate')!.best).toEqual([true, false, false])
  })

  it('takes the larger value when a band is listed twice, and says "none" for a band a known product lacks', () => {
    expect(lineOf(r, '5 GHz_tx')!.cells[1]).toEqual(['27 dBm'])
    const noSix = buildCatalog([product({ slug: 'a' }), product({ slug: 'b' })], [ap('a', [radio('6 GHz', { tx_power_dbm: 23 })]), ap('b', [radio('5 GHz')])])
    expect(lineOf(noSix, '6 GHz_tx')!.cells).toEqual([['23 dBm'], ['none']])
  })

  it('drops the old unlabelled rows and keeps only non-Wi-Fi radios in the summary', () => {
    expect(lineOf(r, 'tx_6ghz')).toBeUndefined()
    expect(lineOf(r, 'max_gain')).toBeUndefined()
    expect(lineOf(r, 'radios')!.cells).toEqual([['none'], ['Bluetooth'], null])
  })

  it('has no band rows for a switch', () => {
    expect(buildComparison(rows()).flatMap((s) => s.lines).some((l) => l.id.includes('GHz'))).toBe(false)
  })
})

describe('sales and price changes in a comparison', () => {
  const day = 86_400_000
  const r = buildCatalog(
    [
      product({ slug: 'a', variants: [variant({ price_cents: 27900, regular_price_cents: 34900, last_change: 'Price decreased', last_changed: new Date(Date.now() - 3 * day).toISOString() })] }),
      product({ slug: 'b', variants: [variant({ price_cents: 20000, last_change: 'Back in stock' })] }),
      product({ slug: 'c', variants: [variant({ price_cents: 10000, status: 'SoldOut' })] }),
    ],
    [],
  )

  it('shows the discount and what the price last did, only when it was a price change', () => {
    expect(lineOf(r, 'sale')!.cells).toEqual([['20% off, was $349'], ['none'], ['none']])
    expect(lineOf(r, 'price_change')!.cells).toEqual([['Price decreased 3 days ago'], ['no recent change'], ['no recent change']])
  })

  it('leaves those lines out when no product has a sale or a price change', () => {
    const plain = buildCatalog([product({ slug: 'a' }), product({ slug: 'b' })], [])
    expect(lineOf(plain, 'sale')).toBeUndefined()
    expect(lineOf(plain, 'price_change')).toBeUndefined()
  })

  it('does not crown a price nobody can pay', () => {
    expect(lineOf(r, 'price')!.best).toEqual([false, true, false]) // c is cheaper but sold out
  })
})

describe('cleanRefs', () => {
  it('keeps well-formed references once each, up to the limit', () => {
    expect(cleanRefs(['us/a', 'us/a', 'nonsense', 'us/b/c', '', 'eu/d', 'us/e', 'us/f', 'us/g'])).toEqual(['us/a', 'eu/d', 'us/e', 'us/f'])
    expect(cleanRefs(['us/a', 'us/b', 'us/c', 'us/d', 'us/e'])).toHaveLength(MAX_COMPARE)
  })
})
