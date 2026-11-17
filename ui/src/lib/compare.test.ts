import { buildCatalog } from './catalog'
import { buildComparison, cleanRefs, MAX_COMPARE } from './compare'
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
    expect(line('price')!.best).toEqual([true, false]) // cheaper wins
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

describe('cleanRefs', () => {
  it('keeps well-formed references once each, up to the limit', () => {
    expect(cleanRefs(['us/a', 'us/a', 'nonsense', 'us/b/c', '', 'eu/d', 'us/e', 'us/f', 'us/g'])).toEqual(['us/a', 'eu/d', 'us/e', 'us/f'])
    expect(cleanRefs(['us/a', 'us/b', 'us/c', 'us/d', 'us/e'])).toHaveLength(MAX_COMPARE)
  })
})
