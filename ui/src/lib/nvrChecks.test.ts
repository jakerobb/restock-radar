import type { Derived, Product } from '../api/types'
import { derived, port, product, variant } from '../test/fixtures'
import { buildCatalog } from './catalog'
import { findNvrs } from './nvrFinder'
import { cameraClass } from './nvrChecks'
import { viewLine, type PlanLine } from './plan'
import { planChecks, type DerivedLine } from './planChecks'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
const metric = (name: string, value: number, unit = '') => ({ name, value, unit, at_least: false, raw: '' })
const nvrCaps = (hd: number, k2: number, k4: number) => [metric('nvr_cameras_hd', hd), metric('nvr_cameras_2k', k2), metric('nvr_cameras_4k', k4)]

interface Spec {
  slug: string
  category: string
  cents: number
  status?: 'Available' | 'SoldOut'
  d: Partial<Derived>
}
const cam = (slug: string, mp: number | null): Spec => ({
  slug,
  category: 'physical-security-dome-turret',
  cents: 15000,
  d: { metrics: [...(mp === null ? [] : [metric('camera_megapixels', mp, 'MP')]), metric('power_draw_max_w', 8)], power: [{ kind: 'poe', poe_class: 'PoE', detail: 'PoE' }], known: { ...known, poe: false } },
})
const nvr = (slug: string, cents: number, caps: [number, number, number], extra: Partial<Derived> = {}, status: 'Available' | 'SoldOut' = 'Available'): Spec => ({
  slug,
  category: 'physical-security-nvr',
  cents,
  status,
  d: { ...extra, metrics: [...nvrCaps(...caps), ...(extra.metrics ?? [])] },
})

function setup(specs: Spec[]) {
  const products: Product[] = specs.map((s, i) => product({ id: s.slug, slug: s.slug, title: s.slug, type: 'Cameras & Security', category: s.category, variants: [variant({ id: s.slug, num: i + 1, sku: s.slug.toUpperCase(), price_cents: s.cents, status: s.status ?? 'Available' })] }))
  const ds = specs.map((s) => derived({ slug: s.slug, known, ...s.d }))
  const map = new Map(products.map((p) => [`${p.region}/${p.slug}`, p]))
  const plan = (...items: [string, number][]): DerivedLine[] =>
    items.map(([slug, qty]) => {
      const l: PlanLine = { ref: `us/${slug}`, sku: slug.toUpperCase(), qty, addedCents: null }
      return { view: viewLine(l, map), derived: ds.find((d) => d.slug === slug) ?? null }
    })
  return { rows: buildCatalog(products, ds), map, plan }
}

const UNVR = nvr('unvr', 30000, [60, 30, 18])
const find = (s: ReturnType<typeof setup>, ...items: [string, number][]) => planChecks(s.plan(...items)).find((c) => c.id === 'nvr')

describe('cameraClass', () => {
  it('counts a camera in the smallest class that holds its sensor, rounding up', () => {
    expect([2, 2.1, 4, 5, 8.3, 16].map(cameraClass)).toEqual(['hd', 'hd', '2k', '4k', '4k', '4k'])
  })
})

describe('the NVR check', () => {
  it('says nothing without cameras', () => {
    expect(find(setup([UNVR, cam('c4k', 8.3)]), ['unvr', 1])).toBeUndefined()
  })

  it('notes the absence of an NVR and says it can be fixed', () => {
    const s = setup([UNVR, cam('c4k', 8.3)])
    expect(find(s, ['c4k', 3])).toMatchObject({ verdict: 'warn', nvrShortfall: true, text: '3 cameras in the plan, and no NVR to record them.' })
  })

  it('adds up each camera as a share of the NVR by class: four 4K and ten 2K on a UNVR', () => {
    const s = setup([UNVR, cam('c4k', 8.3), cam('c2k', 4)])
    const c = find(s, ['unvr', 1], ['c4k', 4], ['c2k', 10])
    expect(c).toMatchObject({ verdict: 'ok', text: '14 cameras use 56% of the NVR’s capacity.' }) // 4/18 + 10/30
    expect(c?.nvr?.spare).toBeCloseTo(1 - 4 / 18 - 10 / 30)
    expect(c?.detail?.[0]?.rows[0]).toBe('4 × 4K, 10 × 2K: 56% of its camera capacity used, 44% left')
  })

  it('flags cameras the NVR has no room for', () => {
    const s = setup([UNVR, cam('c4k', 8.3)])
    expect(find(s, ['unvr', 1], ['c4k', 18])).toMatchObject({ verdict: 'ok' })
    expect(find(s, ['unvr', 1], ['c4k', 19])).toMatchObject({ verdict: 'bad', nvrShortfall: true, text: "1 of 19 cameras have no room on the plan's NVR.", nvr: { unplaced: 1 } })
  })

  it('shares cameras between NVRs', () => {
    const s = setup([UNVR, cam('c4k', 8.3)])
    const c = find(s, ['unvr', 2], ['c4k', 30])
    expect(c).toMatchObject({ verdict: 'ok', text: '30 cameras use 83% of the NVRs’ combined capacity.' })
    expect(c?.detail?.map((b) => b.title)).toEqual(['unvr (1 of 2)', 'unvr (2 of 2)'])
  })

  it('says when a camera’s resolution is not known', () => {
    const s = setup([UNVR, cam('c4k', 8.3), cam('mystery', null)])
    expect(find(s, ['unvr', 1], ['c4k', 9], ['mystery', 2])).toMatchObject({ verdict: 'unknown', text: expect.stringContaining('Can\'t tell for 2 cameras') })
  })

  it('does not take an accessory for a camera', () => {
    const s = setup([UNVR, { ...cam('thing', 8.3), category: 'physical-security-accessories' }])
    expect(find(s, ['thing', 4])).toBeUndefined()
  })
})

describe('findNvrs', () => {
  const small = nvr('small', 20000, [15, 8, 6])
  const big = nvr('big', 100000, [100, 70, 50])
  const gone = nvr('gone', 10000, [60, 30, 18], {}, 'SoldOut')
  const names = (s: ReturnType<typeof setup>, ...items: [string, number][]) => findNvrs(s.plan(...items), s.rows, s.map).options.map((o) => `${o.label}: ${o.qty} × ${o.row.product.slug}`)

  it('offers the cheapest that has room, the one with the most room, and a cheaper one that is out of stock', () => {
    const s = setup([small, UNVR, big, gone, cam('c4k', 8.3)])
    // 7 4K cameras: too many for one small (6), so two of those, which cost less than twice the UNVR and have the most room. The big one is over that.
    expect(names(s, ['c4k', 7])).toEqual(['Cheapest that fits: 1 × unvr', 'Most room to spare: 2 × small', 'Cheaper, but not in stock: 1 × gone'])
  })

  it('suggests several of one when that is the way', () => {
    const s = setup([small, cam('c4k', 8.3)])
    expect(names(s, ['c4k', 11])).toEqual(['Cheapest that fits: 2 × small'])
  })

  it('counts an NVR already in the plan, so only the shortfall is made up', () => {
    const s = setup([small, UNVR, cam('c4k', 8.3)])
    const { options } = findNvrs(s.plan(['small', 1], ['c4k', 8]), s.rows, s.map) // the small holds 6; another small covers the rest
    expect(options[0]).toMatchObject({ qty: 1 })
    expect(options[0]?.row.product.slug).toBe('small')
  })

  it('lists them all and offers nothing when no NVR does', () => {
    const s = setup([small, UNVR, cam('c4k', 8.3)])
    expect(findNvrs(s.plan(['c4k', 7]), s.rows, s.map).all.map((o) => `${o.qty} × ${o.row.product.slug}`)).toEqual(['1 × unvr', '2 × small'])
    expect(findNvrs(s.plan(['c4k', 99]), s.rows, s.map)).toEqual({ options: [], all: [] })
  })

  it('takes part in the PoE checks when the NVR has a switch built in', () => {
    const instant = nvr('instant', 25000, [15, 8, 6], { ports: [port({ count: 6, max_speed_mbps: 1000, poe_class: 'PoE', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 40, 'W')], power: [{ kind: 'ac', poe_class: '', detail: 'AC' }] })
    const s = setup([instant, cam('c4k', 8.3)])
    const before = planChecks(s.plan(['c4k', 4]))
    expect(before.find((c) => c.id === 'poe-power')).toMatchObject({ shortfall: true }) // nothing supplies PoE
    const after = planChecks(s.plan(['c4k', 4], ['instant', 1]))
    expect(after.find((c) => c.id === 'poe-power')).toMatchObject({ verdict: 'ok', text: 'Devices draw up to 32 W of the 40 W supplied.' })
  })
})
