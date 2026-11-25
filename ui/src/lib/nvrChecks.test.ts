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
  it('warns when an NVR in the plan cannot be bought now', () => {
    const s = setup([nvr('gone', 10000, [60, 30, 18], {}, 'SoldOut'), cam('c4k', 8.3)])
    const checks = planChecks(s.plan(['gone', 1], ['c4k', 2]))
    expect(checks.find((c) => c.id === 'nvr-stock')).toBeUndefined()
    expect(checks.find((c) => c.id === 'stock')).toMatchObject({ verdict: 'warn', nvrShortfall: true, stock: { note: expect.stringContaining('camera capacity') } })
  })

  it('says nothing without cameras', () => {
    expect(find(setup([UNVR, cam('c4k', 8.3)]), ['unvr', 1])).toBeUndefined()
  })

  it('notes the absence of an NVR and says it can be fixed', () => {
    const s = setup([UNVR, cam('c4k', 8.3)])
    expect(find(s, ['c4k', 3])).toMatchObject({ verdict: 'warn', nvrShortfall: true, text: '3 cameras in the plan, and no NVR (Protect controller) to record them.' })
  })

  it('adds up each camera as a share of the NVR by class: four 4K and ten 2K on a UNVR', () => {
    const s = setup([UNVR, cam('c4k', 8.3), cam('c2k', 4)])
    const c = find(s, ['unvr', 1], ['c4k', 4], ['c2k', 10])
    expect(c).toMatchObject({ verdict: 'ok', text: '14 cameras use 56% of the NVR’s capacity.' }) // 4/18 + 10/30
    expect(c?.nvr?.spare).toBeCloseTo(1 - 4 / 18 - 10 / 30)
    expect(c?.nvr).toMatchObject({ benchmark: '4k', room: 8 }) // 44% of 18 4K cameras
    expect(c?.detail?.[0]?.rows[0]).toBe('4 × 4K, 10 × 2K: 56% of its camera capacity used, 44% left')
  })

  it('counts the room left in the highest class among the cameras in the plan: 2K alone, a mix up to 4K, and 4K when no resolution is known', () => {
    const s = setup([UNVR, cam('c4k', 8.3), cam('c2k', 4), cam('cunk', null)])
    expect(find(s, ['unvr', 1], ['c2k', 10])?.nvr).toMatchObject({ benchmark: '2k', room: 20 }) // 2/3 of 30
    expect(find(s, ['unvr', 1], ['c2k', 10], ['c4k', 1])?.nvr).toMatchObject({ benchmark: '4k', room: 11 }) // 1 - 10/30 - 1/18 = 0.611 of 18
    expect(find(s, ['unvr', 1], ['cunk', 3])?.nvr).toMatchObject({ benchmark: '4k', room: 18 })
  })

  it('flags cameras the NVR has no room for', () => {
    const s = setup([UNVR, cam('c4k', 8.3)])
    expect(find(s, ['unvr', 1], ['c4k', 18])).toMatchObject({ verdict: 'ok' })
    expect(find(s, ['unvr', 1], ['c4k', 19])).toMatchObject({ verdict: 'bad', nvrShortfall: true, text: "1 of 19 cameras have no room on the plan's NVR.", nvr: { unplaced: 1 } })
  })

  it('fills one NVR before using a second, and warns when it has to spill over', () => {
    const s = setup([UNVR, cam('c4k', 8.3)])
    const few = find(s, ['unvr', 2], ['c4k', 10])
    expect(few).toMatchObject({ verdict: 'ok', text: '10 cameras use 28% of the NVRs’ combined capacity.' })
    expect(few?.detail?.map((b) => b.rows[0])).toEqual([expect.stringContaining('10 × 4K'), 'No cameras on it'])
    const c = find(s, ['unvr', 2], ['c4k', 30])
    expect(c).toMatchObject({ verdict: 'warn', text: expect.stringContaining('83% of the NVRs’ combined capacity. Cameras are spread over several NVRs') })
    expect(c?.detail?.map((b) => b.title)).toEqual(['unvr (1 of 2)', 'unvr (2 of 2)'])
    expect(c?.detail?.[0]?.rows[0]).toContain('18 × 4K')
  })

  it('starts with the NVR of the most capacity', () => {
    const big = nvr('big', 100000, [100, 70, 50])
    const s = setup([UNVR, big, cam('c4k', 8.3)])
    expect(find(s, ['unvr', 1], ['big', 1], ['c4k', 5])?.detail?.map((b) => b.rows[0])).toEqual([expect.stringContaining('5 × 4K'), 'No cameras on it'])
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

const drive = (slug: string): Spec => ({ slug, category: 'accessories-storage', cents: 70000, d: {} })
const bayNvr = (slug: string, bays: number, extra: Partial<Derived> = {}) => nvr(slug, 30000, [60, 30, 18], { ...extra, metrics: [metric('nvr_drive_bays', bays, 'bays'), ...(extra.metrics ?? [])] })
const rows = (c: ReturnType<typeof find>) => c?.detail?.flatMap((b) => b.rows.flatMap((r) => (typeof r === 'string' ? [r] : [r.text, ...r.items]))) ?? []

describe('the storage of an NVR', () => {
  // Ten 4K cameras at 12 Mbps each record 120 Mbps: 1 TB lasts 1e12 * 8 / 120e6 s, or 0.77 days.
  const four = () => setup([bayNvr('bays4', 4), drive('uacc-hdd-e-16tb'), cam('c4k', 8.3)])

  it('gives each way to protect four drives, with the effective storage and days of footage', () => {
    const s = four()
    const r = rows(find(s, ['bays4', 1], ['uacc-hdd-e-16tb', 4], ['c4k', 10]))
    expect(r).toContain('4 × 16 TB drives, 64 TB raw storage:')
    expect(r).toContain('RAID 5: 48 TB effective; approximately 37 days of footage')
    expect(r).toContain('RAID 10: 32 TB effective; approximately 25 days of footage')
  })

  it('has one way to protect two or three drives, and none for one', () => {
    const s = four()
    expect(rows(find(s, ['bays4', 1], ['uacc-hdd-e-16tb', 2], ['c4k', 10])).filter((x) => x.startsWith('RAID'))).toEqual(['RAID 1: 16 TB effective; approximately 12 days of footage'])
    expect(rows(find(s, ['bays4', 1], ['uacc-hdd-e-16tb', 3], ['c4k', 10])).filter((x) => x.startsWith('RAID'))).toEqual(['RAID 5: 32 TB effective; approximately 25 days of footage'])
    expect(rows(find(s, ['bays4', 1], ['uacc-hdd-e-16tb', 1], ['c4k', 10])).some((x) => x.startsWith('16 TB effective; approximately 12'))).toBe(true)
  })

  it('shares the plan’s drives among the NVRs, and never puts more in one than it has bays', () => {
    const s = setup([bayNvr('a', 4), bayNvr('b', 4), drive('uacc-hdd-e-16tb')])
    const c = find(s, ['a', 2], ['uacc-hdd-e-16tb', 4], ['c4k', 1]) // no cameras defined: just the drives
    expect(c).toBeUndefined()
    const s2 = setup([bayNvr('a', 2), drive('uacc-hdd-e-16tb'), cam('c4k', 8.3)])
    expect(rows(find(s2, ['a', 1], ['uacc-hdd-e-16tb', 6], ['c4k', 1]))).toContain('2 × 16 TB drives, 32 TB raw storage:')
  })

  it('says so when there are no drives, and not that the plan fails', () => {
    const c = find(four(), ['bays4', 1], ['c4k', 10])
    expect(rows(c).some((x) => x.startsWith('No drives in the plan for its 4 bays'))).toBe(true)
    expect(c?.verdict).toBe('ok')
  })

  it('offers RAID 6 from nine drives, on an NVR with the bays for it', () => {
    const s = setup([bayNvr('big', 16), drive('uacc-hdd-e-16tb'), cam('c4k', 8.3)])
    const r = rows(find(s, ['big', 1], ['uacc-hdd-e-16tb', 10], ['c4k', 10])).filter((x) => x.startsWith('RAID'))
    expect(r.map((x) => x.split(':')[0])).toEqual(['RAID 5', 'RAID 6', 'RAID 10'])
    const nine = rows(find(s, ['big', 1], ['uacc-hdd-e-16tb', 9], ['c4k', 10])).filter((x) => x.startsWith('RAID'))
    expect(nine.map((x) => x.split(':')[0])).toEqual(['RAID 5', 'RAID 6'])
  })

  it('counts the storage a gateway has in its M.2 slot or an NVR has built in', () => {
    const gw = nvr('gw', 20000, [30, 15, 9], { metrics: [] })
    const s = setup([gw, drive('uacc-ssd-2tb'), cam('c4k', 8.3), nvr('uck', 25000, [20, 10, 5], { metrics: [metric('nvr_storage_tb', 1, 'TB')] })])
    s.map.get('us/gw')!.linked = [{ slug: 'uacc-ssd-2tb' }]
    expect(rows(find(s, ['gw', 1], ['uacc-ssd-2tb', 1], ['c4k', 2]))).toContain('2 TB effective; approximately 7.7 days of footage')
    expect(rows(find(s, ['uck', 1], ['c4k', 2]))).toContain('1 TB of storage built in: approximately 3.9 days of footage')
  })
})

describe('findNvrs', () => {
  const small = nvr('small', 20000, [15, 8, 6])
  const big = nvr('big', 100000, [100, 70, 50])
  const gone = nvr('gone', 10000, [60, 30, 18], {}, 'SoldOut')
  const names = (s: ReturnType<typeof setup>, ...items: [string, number][]) => findNvrs(s.plan(...items), s.rows, s.map).options.map((o) => `${o.label}: ${o.row.product.slug}`)

  it('offers the cheapest that has room, and a cheaper one that is out of stock', () => {
    const s = setup([small, UNVR, big, gone, cam('c4k', 8.3)])
    // 7 4K cameras: too many for the small (6). The UNVR is the cheapest in stock that holds them; the big one is dearer.
    expect(names(s, ['c4k', 7])).toEqual(['Cheapest that fits: unvr', 'Cheaper, but not in stock: gone'])
  })

  it('never suggests several of one NVR', () => {
    const s = setup([small, cam('c4k', 8.3)])
    expect(findNvrs(s.plan(['c4k', 11]), s.rows, s.map)).toEqual({ options: [], all: [] }) // two smalls would hold them, but one is all we try
  })

  it('counts an NVR already in the plan, so only the shortfall is made up', () => {
    const s = setup([small, UNVR, cam('c4k', 8.3)])
    const { options } = findNvrs(s.plan(['small', 1], ['c4k', 8]), s.rows, s.map) // the small holds 6; another small covers the rest
    expect(options[0]?.row.product.slug).toBe('small')
  })

  it('lists them all and offers nothing when no NVR does', () => {
    const s = setup([small, UNVR, cam('c4k', 8.3)])
    expect(findNvrs(s.plan(['c4k', 7]), s.rows, s.map).all.map((o) => o.row.product.slug)).toEqual(['unvr'])
    expect(findNvrs(s.plan(['c4k', 99]), s.rows, s.map)).toEqual({ options: [], all: [] })
  })

  it('checks the plan without an NVR that is sold out, and offers stand-ins for it', () => {
    const s = setup([gone, small, cam('c4k', 8.3)])
    const { options } = findNvrs(s.plan(['gone', 1], ['c4k', 5]), s.rows, s.map)
    expect(options[0]?.row.product.slug).toBe('small')
    expect(options[0]?.replaces.map((l) => l.view.line.ref)).toEqual(['us/gone'])
    expect(options.every((o) => o.row.product.slug !== 'gone')).toBe(true) // the sold-out one isn't offered back
  })

  it('also suggests a gateway that records, one of it, and says so', () => {
    const udr = { ...nvr('udr', 20000, [5, 2, 1]), category: 'cloud-gateways-wifi-integrated' }
    const s = setup([udr, cam('c4k', 8.3)])
    const { options } = findNvrs(s.plan(['c4k', 1]), s.rows, s.map)
    expect(options).toMatchObject([{ alsoGateway: true }])
    expect(findNvrs(s.plan(['c4k', 2]), s.rows, s.map).options).toEqual([]) // two of a gateway aren't suggested
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
