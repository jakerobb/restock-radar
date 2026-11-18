import type { Derived, Product } from '../api/types'
import { buildCatalog } from './catalog'
import { viewLine, type PlanLine } from './plan'
import type { DerivedLine } from './planChecks'
import { findSwitches } from './switchFinder'
import { derived, port, product, variant } from '../test/fixtures'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
const metric = (name: string, value: number) => ({ name, value, unit: 'W', at_least: false, raw: '' })

function catalog(specs: { slug: string; type: string; cents: number; status?: 'Available' | 'SoldOut'; d: Partial<Derived> }[]) {
  const products: Product[] = specs.map((s, i) => product({ id: s.slug, slug: s.slug, title: s.slug, type: s.type, variants: [variant({ id: s.slug, num: i + 1, sku: s.slug.toUpperCase(), price_cents: s.cents, status: s.status ?? 'Available' })] }))
  const ds = specs.map((s) => derived({ slug: s.slug, known, ...s.d }))
  const map = new Map(products.map((p) => [`${p.region}/${p.slug}`, p]))
  return { rows: buildCatalog(products, ds), map, ds }
}

const e7 = (): Partial<Derived> => ({ ports: [port({ count: 1, max_speed_mbps: 10000 })], metrics: [metric('power_draw_max_w', 43)], power: [{ kind: 'poe', poe_class: 'PoE++', detail: 'PoE++' }], known: { ...known, poe: false } })
const sw = (ports: number, cls: string, budget: number, speed = 1000): Partial<Derived> => ({ ports: [port({ count: ports, max_speed_mbps: speed, poe_class: cls, poe_direction: 'out' })], metrics: [metric('poe_budget_w', budget)], power: [{ kind: 'ac', poe_class: '', detail: 'AC' }] })

function plan(c: ReturnType<typeof catalog>, ...items: [string, number][]): DerivedLine[] {
  return items.map(([slug, qty]) => {
    const l: PlanLine = { ref: `us/${slug}`, sku: slug.toUpperCase(), qty, addedCents: null }
    return { view: viewLine(l, c.map), derived: c.ds.find((d) => d.slug === slug) ?? null }
  })
}

describe('findSwitches', () => {
  const base = [
    { slug: 'e7', type: 'WiFi', cents: 54900, d: e7() },
    { slug: 'small', type: 'Switches', cents: 30000, d: sw(8, 'PoE++', 150) },
    { slug: 'mid', type: 'Switches', cents: 55000, d: sw(24, 'PoE++', 400) },
    { slug: 'fast', type: 'Switches', cents: 110000, d: sw(24, 'PoE++', 600, 10000) },
    { slug: 'weak', type: 'Switches', cents: 10000, d: sw(8, 'PoE', 120) },
    { slug: 'nobudget', type: 'Switches', cents: 5000, d: { ports: [port({ count: 8, poe_class: 'PoE++', poe_direction: 'out' })] } },
    { slug: 'dumb', type: 'Switches', cents: 5000, d: { ports: [port({ count: 8 })] } },
  ]
  const slugs = (c: ReturnType<typeof catalog>, ...items: [string, number][]) => findSwitches(plan(c, ...items), c.rows, c.map).options.map((o) => `${o.label}: ${o.qty} × ${o.row.product.slug}`)

  it('suggests the cheapest that works and the cheapest that keeps every device at full speed', () => {
    // 6 E7 draw 258 W. One small (150 W) is not enough and the weak one has too low a class; two small cost more than one mid.
    expect(slugs(catalog(base), ['e7', 6])).toEqual(['Cheapest that fits: 1 × mid', 'Cheapest at full speed: 1 × fast'])
  })

  it('never suggests a switch with no PoE, no known budget, or ports of too low a class', () => {
    const c = catalog(base)
    const all = findSwitches(plan(c, ['e7', 2]), c.rows, c.map).options.map((o) => o.row.product.slug)
    for (const bad of ['weak', 'nobudget', 'dumb']) expect(all).not.toContain(bad)
  })

  it('suggests several of one switch when that is the cheapest way', () => {
    const c = catalog(base.filter((b) => b.slug !== 'mid' && b.slug !== 'fast'))
    const [first] = findSwitches(plan(c, ['e7', 12]), c.rows, c.map).options // 516 W and 12 ports: two small switches have neither
    expect(first).toMatchObject({ qty: 4, cents: 120000 }) // four small: 600 W, 32 ports
  })

  it('counts a switch already in the plan, so only the shortfall is made up', () => {
    const c = catalog(base)
    // One small is in the plan (150 W, 8 ports) for 6 E7; a second small covers it.
    const { options } = findSwitches(plan(c, ['e7', 6], ['small', 1]), c.rows, c.map)
    expect(options[0]).toMatchObject({ label: 'Cheapest that fits', qty: 1 })
    expect(options[0]!.row.product.slug).toBe('small') // 2 small = 300 W ≥ 258 W and 16 ports, for $300
  })

  it('offers a cheaper switch that is out of stock as such', () => {
    const c = catalog([...base, { slug: 'gone', type: 'Switches', cents: 20000, status: 'SoldOut' as const, d: sw(24, 'PoE++', 400) }])
    const { options } = findSwitches(plan(c, ['e7', 6]), c.rows, c.map)
    expect(options.map((o) => o.label)).toContain('Cheaper, but not in stock')
    expect(options.find((o) => o.label === 'Cheaper, but not in stock')).toMatchObject({ inStock: false, cents: 20000 })
    expect(options[0]!.inStock).toBe(true)
  })

  it('says nothing fits when even several of the same do not', () => {
    const c = catalog(base)
    expect(findSwitches(plan(c, ['e7', 99]), c.rows, c.map)).toMatchObject({ options: [], all: [], hidden: 0 })
  })

  it('has nothing to suggest for a plan with no PoE devices', () => {
    const c = catalog(base)
    expect(findSwitches([], c.rows, c.map).options).toEqual([])
  })

  it('says when a device’s draw is unknown, so the fit counts only the rest', () => {
    const c = catalog([...base, { slug: 'cam', type: 'Cameras', cents: 10000, d: { ports: [port({ count: 1, poe_class: 'PoE+', poe_direction: 'in' })] } }])
    const { options } = findSwitches(plan(c, ['e7', 2], ['cam', 1]), c.rows, c.map)
    expect(options[0]!.partial).toBe(true)
  })

  it('never suggests a switch that leaves a device crawling, however cheap, and says how slow the rest run', () => {
    const c = catalog([...base, { slug: 'longrange', type: 'Switches', cents: 20000, d: sw(8, 'PoE++', 400, 100) }])
    const { options } = findSwitches(plan(c, ['e7', 6]), c.rows, c.map)
    expect(options.map((o) => o.row.product.slug)).not.toContain('longrange')
    // The mid switch's 1 GbE ports are slow for a 10 GbE device, but not crawling; the stats say by how much.
    expect(options[0]!.stats).toMatchObject({ slowed: 6, slowestMbps: 1000, slowedFromMbps: 10000, crawling: 0 })
  })

  it('suggests a faster switch when the plan only falls short on speed, and nothing that would not help', () => {
    const c = catalog(base)
    // One mid switch carries 6 E7 (258 W) but at 1 GbE. Another mid would not speed anything up; the fast one does.
    const { options } = findSwitches(plan(c, ['e7', 6], ['mid', 1]), c.rows, c.map)
    expect(options.map((o) => o.row.product.slug)).toEqual(['fast'])
    expect(options[0]!.stats.slowed).toBe(0)
  })

  it('checks the plan without a switch that is sold out, and offers stand-ins for it', () => {
    const c = catalog(base.map((b) => (b.slug === 'mid' ? { ...b, status: 'SoldOut' as const } : b)))
    const { options } = findSwitches(plan(c, ['e7', 6], ['mid', 1]), c.rows, c.map)
    expect(options[0]!.replaces.map((l) => l.view.line.ref)).toEqual(['us/mid'])
    expect(options[0]!.row.product.slug).not.toBe('mid')
  })

  describe('two different switches', () => {
    const cam = (): Partial<Derived> => ({ ports: [port({ count: 1, max_speed_mbps: 1000 })], metrics: [metric('power_draw_max_w', 15)], power: [{ kind: 'poe', poe_class: 'PoE+', detail: 'PoE+' }], known: { ...known, poe: false } })
    const mixed = [
      { slug: 'e7', type: 'WiFi', cents: 54900, d: e7() },
      { slug: 'cam', type: 'Cameras', cents: 10000, d: cam() },
      { slug: 'tenG', type: 'Switches', cents: 30000, d: sw(2, 'PoE++', 100, 10000) },
      { slug: 'gig', type: 'Switches', cents: 40000, d: sw(8, 'PoE++', 150) },
    ]

    it('pairs a 10G switch with a gigabit one when that beats any one model', () => {
      const c = catalog(mixed)
      // 2 E7 and 8 cameras: 10 ports and 206 W. Two gig switches have the ports but slow the E7s; the pair is cheaper and full speed.
      const { options } = findSwitches(plan(c, ['e7', 2], ['cam', 8]), c.rows, c.map)
      expect(options.map((o) => `${o.label}: ${o.qty} × ${o.row.product.slug}${o.also ? ` + ${o.also.qty} × ${o.also.row.product.slug}` : ''}`)).toEqual([
        'Cheapest that fits: 2 × gig',
        'Two switches, cheapest: 1 × tenG + 1 × gig',
      ])
      const pair = options[1]!
      expect(pair.cents).toBe(70000)
      expect(pair.stats.slowed).toBe(0)
    })

    it('lists pairs in the full list too, in price order, when they undercut any one model', () => {
      const c = catalog(mixed)
      const { all } = findSwitches(plan(c, ['e7', 2], ['cam', 8]), c.rows, c.map)
      expect(all.map((o) => `${o.qty} × ${o.row.product.slug}${o.also ? ` + ${o.also.qty} × ${o.also.row.product.slug}` : ''}`)).toEqual(['1 × tenG + 1 × gig', '2 × gig'])
    })

    it('does not offer a pair when one model, or the same model again, does the job', () => {
      const c = catalog(mixed)
      const { options } = findSwitches(plan(c, ['e7', 1], ['cam', 1]), c.rows, c.map)
      expect(options.every((o) => !o.also)).toBe(true)
    })
  })

  describe('power methods', () => {
    const dc = { slug: 'dc', type: 'Switches', cents: 10000, d: { ...sw(24, 'PoE++', 600, 10000), power: [{ kind: 'dc' as const, poe_class: '', detail: 'DC' }] } }
    const poeFed = { slug: 'poefed', type: 'Switches', cents: 12000, d: { ...sw(24, 'PoE++', 600, 10000), power: [{ kind: 'ac' as const, poe_class: '', detail: 'AC' }, { kind: 'poe' as const, poe_class: 'PoE++', detail: 'PoE++' }] } }
    const unsaid = { slug: 'unsaid', type: 'Switches', cents: 9000, d: { ...sw(24, 'PoE++', 600, 10000), power: [] } }

    it('leaves out switches that can only run on a method that is not accepted, and says how many', () => {
      const c = catalog([...base, dc, unsaid])
      const found = findSwitches(plan(c, ['e7', 6]), c.rows, c.map, new Set(['ac', 'poe']))
      expect(found.all.map((o) => o.row.product.slug)).not.toContain('dc')
      expect(found.hidden).toBe(2) // the DC one, and the one that doesn't say how it is powered
      const withDc = findSwitches(plan(c, ['e7', 6]), c.rows, c.map, new Set(['dc']))
      expect(withDc.all.map((o) => o.row.product.slug)).toEqual(['dc'])
    })

    it('accepts a switch that can use any one of the accepted methods', () => {
      const c = catalog([...base, poeFed])
      const found = findSwitches(plan(c, ['e7', 6]), c.rows, c.map, new Set(['poe']))
      expect(found.all.map((o) => o.row.product.slug)).toEqual(['poefed'])
    })

    it('lists every acceptable switch, cheapest first', () => {
      const c = catalog(base)
      const { all, options } = findSwitches(plan(c, ['e7', 6]), c.rows, c.map)
      expect(all.length).toBeGreaterThanOrEqual(options.length)
      expect(all.map((o) => o.cents)).toEqual([...all.map((o) => o.cents)].sort((a, b) => a! - b!))
    })
  })
})
