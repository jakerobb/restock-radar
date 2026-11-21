import type { Derived, Product } from '../api/types'
import { buildCatalog } from './catalog'
import { viewLine, type PlanLine } from './plan'
import type { DerivedLine } from './planChecks'
import { findInjectors } from './injectorFinder'
import { derived, port, product, variant } from '../test/fixtures'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
const metric = (name: string, value: number) => ({ name, value, unit: 'W', at_least: false, raw: '' })
const ac = [{ kind: 'ac' as const, poe_class: '', detail: 'AC' }]

function catalog(specs: { slug: string; type: string; cents: number; status?: 'Available' | 'SoldOut'; d: Partial<Derived> }[]) {
  const products: Product[] = specs.map((s, i) => product({ id: s.slug, slug: s.slug, title: s.slug, type: s.type, variants: [variant({ id: s.slug, num: i + 1, sku: s.slug.toUpperCase(), price_cents: s.cents, status: s.status ?? 'Available' })] }))
  const ds = specs.map((s) => derived({ slug: s.slug, known, ...s.d }))
  const map = new Map(products.map((p) => [`${p.region}/${p.slug}`, p]))
  return { rows: buildCatalog(products, ds), map, ds }
}

function plan(c: ReturnType<typeof catalog>, ...items: [string, number][]): DerivedLine[] {
  return items.map(([slug, qty]) => {
    const l: PlanLine = { ref: `us/${slug}`, sku: slug.toUpperCase(), qty, addedCents: null }
    return { view: viewLine(l, c.map), derived: c.ds.find((d) => d.slug === slug) ?? null }
  })
}

/** A camera, which takes PoE+ at 8 W, and a switch with 4 PoE+ ports of a 30 W budget, and 4 that give none. */
const cam = (cls = 'PoE+', speed = 1000): Partial<Derived> => ({ ports: [port({ count: 1, max_speed_mbps: speed, poe_class: cls, poe_direction: 'in' })], metrics: [metric('power_draw_max_w', 8)] })
const sw = (plain = 4, speed = 1000): Partial<Derived> => ({ ports: [port({ count: 4, poe_class: 'PoE+', poe_direction: 'out' }), ...(plain > 0 ? [port({ count: plain, max_speed_mbps: speed })] : [])], metrics: [metric('poe_budget_w', 30)], power: ac })
/** What deriveInjector gives: a port to plug into a switch, and one PoE port out, of a budget of its own. */
const inj = (cls: string, watts: number, speed = 1000): Partial<Derived> => ({
  ports: [port({ count: 1, max_speed_mbps: speed, source: 'injector' }), port({ count: 1, max_speed_mbps: speed, poe_class: cls, poe_direction: 'out', source: 'injector' })],
  metrics: [metric('poe_budget_w', watts)],
  power: ac,
})

const base = [
  { slug: 'cam', type: 'Cameras', cents: 19900, d: cam() },
  { slug: 'sw', type: 'Switches', cents: 30000, d: sw() },
  { slug: 'af', type: 'Accessories', cents: 800, d: inj('PoE', 15.4) },
  { slug: 'at', type: 'Accessories', cents: 1500, d: inj('PoE+', 30) },
  { slug: 'bt', type: 'Accessories', cents: 2900, d: inj('PoE++', 60) },
  { slug: 'at25', type: 'Accessories', cents: 1900, d: inj('PoE+', 30, 2500) },
]

describe('findInjectors', () => {
  const slugs = (c: ReturnType<typeof catalog>, ...items: [string, number][]) => findInjectors(plan(c, ...items), c.rows, c.map).options.map((o) => `${o.label}: ${o.adds.map((a) => `${a.qty} × ${a.row.product.slug}`).join(' + ')}`)

  it('suggests the cheapest injector of a high enough class, for the devices the switch has no budget left for', () => {
    // Four cameras draw 32 W of the switch's 30 W: one has no power. A PoE injector is too weak for a PoE+ camera.
    const c = catalog(base)
    const found = findInjectors(plan(c, ['cam', 4], ['sw', 1]), c.rows, c.map)
    expect(found.devices).toBe(1)
    expect(slugs(c, ['cam', 4], ['sw', 1])).toEqual(['Cheapest that fits: 1 × at'])
    expect(found.all.map((f) => f.adds[0]!.row.product.slug)).toEqual(['at', 'at25', 'bt'])
  })

  it('offers a slower injector too: the cheapest overall, and the cheapest that keeps the speed', () => {
    const c = catalog([{ slug: 'cam', type: 'Cameras', cents: 19900, d: cam('PoE+', 2500) }, { slug: 'sw', type: 'Switches', cents: 30000, d: sw(4, 2500) }, ...base.slice(2)])
    // A 2.5 GbE camera on a switch with 2.5 GbE ports: the gigabit injector is cheapest but slows it; the 2.5 GbE one keeps its speed.
    expect(slugs(c, ['cam', 4], ['sw', 1])).toEqual(['Cheapest that fits: 1 × at', 'Cheapest at full speed: 1 × at25'])
    // On a switch with only gigabit ports even the 2.5 GbE injector is held to gigabit, so none keeps the camera's speed.
    const slowSwitch = catalog([{ slug: 'cam', type: 'Cameras', cents: 19900, d: cam('PoE+', 2500) }, ...base.slice(1)])
    expect(slugs(slowSwitch, ['cam', 4], ['sw', 1])).toEqual(['Cheapest that fits: 1 × at'])
    const gigabit = catalog([{ slug: 'cam', type: 'Cameras', cents: 19900, d: cam('PoE+', 2500) }, ...base.slice(1).filter((b) => b.slug !== 'at25')])
    const found = findInjectors(plan(gigabit, ['cam', 4], ['sw', 1]), gigabit.rows, gigabit.map)
    expect(found.slow).toBe(true)
    expect(found.options).toHaveLength(1)
    expect(found.options[0]).toMatchObject({ label: 'Cheapest that fits', slowed: 1 })
  })

  it('is for a port that exists but gives no PoE: every camera on a switch with plain ports only', () => {
    const c = catalog([base[0]!, { slug: 'sw', type: 'Switches', cents: 5000, d: { ports: [port({ count: 8 })], power: ac } }, ...base.slice(2)])
    // Four cameras, no PoE anywhere in the plan: an injector each (and four switch ports for them, from 7 after the uplink).
    const found = findInjectors(plan(c, ['cam', 4], ['sw', 1]), c.rows, c.map)
    expect(found.options[0]).toMatchObject({ adds: [{ qty: 4 }], cents: 6000 })
    expect(found.options[0]!.adds[0]!.row.product.slug).toBe('at')
  })

  it("won't suggest an injector when there is no switch port to plug it into", () => {
    const c = catalog([...base.slice(0, 1), { slug: 'sw', type: 'Switches', cents: 30000, d: sw(0) }, ...base.slice(2)])
    // 4 PoE+ ports only: one is the switch's uplink, three go to cameras, and there is none for an injector.
    const found = findInjectors(plan(c, ['cam', 4], ['sw', 1]), c.rows, c.map)
    expect(found.options).toEqual([])
  })

  it('mixes two kinds of injector when the devices differ', () => {
    const c = catalog([{ slug: 'cam', type: 'Cameras', cents: 19900, d: cam() }, { slug: 'ap', type: 'WiFi', cents: 49900, d: { ...cam('PoE++'), metrics: [metric('power_draw_max_w', 40)] } }, { slug: 'sw', type: 'Switches', cents: 5000, d: { ports: [port({ count: 8 })], power: ac } }, base[3]!, base[4]!])
    // Three cameras (PoE+) and an access point (PoE++), no PoE on the switch: three at 15 and one at 29 undercuts four at 29.
    const [first] = findInjectors(plan(c, ['cam', 3], ['ap', 1], ['sw', 1]), c.rows, c.map).options
    expect(first!.cents).toBe(3 * 1500 + 2900)
    expect(first!.adds.map((a) => `${a.qty} × ${a.row.product.slug}`).sort()).toEqual(['1 × bt', '3 × at'])
  })

  it('offers a cheaper injector that is out of stock as such, and says nothing when no device is without power', () => {
    const c = catalog([...base, { slug: 'gone', type: 'Accessories', cents: 500, status: 'SoldOut' as const, d: inj('PoE+', 30) }])
    const found = findInjectors(plan(c, ['cam', 4], ['sw', 1]), c.rows, c.map)
    expect(found.options.find((o) => o.label === 'Cheaper, but not in stock')).toMatchObject({ inStock: false, cents: 500 })
    expect(findInjectors(plan(c, ['cam', 2], ['sw', 1]), c.rows, c.map)).toMatchObject({ devices: 0, options: [] })
  })

  it('counts an injector already in the plan, and replaces one that cannot be bought now', () => {
    const c = catalog([...base, { slug: 'gone', type: 'Accessories', cents: 500, status: 'SoldOut' as const, d: inj('PoE+', 30) }])
    // One injector is already there: nothing is left to power.
    expect(findInjectors(plan(c, ['cam', 4], ['sw', 1], ['at', 1]), c.rows, c.map).devices).toBe(0)
    // One that is sold out counts for nothing, so a stand-in is offered.
    const found = findInjectors(plan(c, ['cam', 4], ['sw', 1], ['gone', 1]), c.rows, c.map)
    expect(found.replaces.map((l) => l.view.line.ref)).toEqual(['us/gone'])
    expect(found.options[0]).toMatchObject({ adds: [{ qty: 1 }] })
  })
})
