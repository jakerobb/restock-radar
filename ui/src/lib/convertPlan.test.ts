import type { Product } from '../api/types'
import { baseSku, convertPlan, matchVariant } from './convertPlan'
import type { PlanLine } from './plan'
import { product, variant } from '../test/fixtures'

const nas = (region: string, suffix: string, over: Partial<Product> = {}) =>
  product({
    region,
    id: 'nas',
    slug: 'unas-2',
    title: 'UNAS 2',
    variants: [variant({ id: `b-${region}`, sku: `UNAS-2-B${suffix}`, title: 'Black' }), variant({ id: `w-${region}`, sku: `UNAS-2-W${suffix}`, title: 'White' })],
    ...over,
  })

const line = (over: Partial<PlanLine> = {}): PlanLine => ({ ref: 'us/unas-2', sku: 'UNAS-2-B', qty: 2, addedCents: 19900, ...over })

describe('baseSku', () => {
  it('drops a trailing region and nothing else', () => {
    expect(baseSku('UNAS-2-B-EU')).toBe('UNAS-2-B')
    expect(baseSku('UNAS-2-B-uk')).toBe('UNAS-2-B')
    expect(baseSku('UNAS-2-B')).toBe('UNAS-2-B')
    expect(baseSku('USW-Pro-Max-24-PoE')).toBe('USW-Pro-Max-24-PoE')
  })
})

describe('matchVariant', () => {
  const us = nas('us', '')
  it('takes the same SKU, else the same SKU bar its region, else the same name', () => {
    expect(matchVariant(us.variants[0]!, us, nas('jp', ''))?.sku).toBe('UNAS-2-B')
    expect(matchVariant(us.variants[1]!, us, nas('eu', '-EU'))?.sku).toBe('UNAS-2-W-EU')
    const renamed = nas('sg', '', { variants: [variant({ sku: 'X-1', title: 'white' }), variant({ sku: 'X-2', title: 'black' })] })
    expect(matchVariant(us.variants[0]!, us, renamed)?.sku).toBe('X-2')
  })
  it('takes the only variant of a single-variant product, and gives up when it cannot tell', () => {
    const one = product({ variants: [variant({ sku: 'A-1', title: 'Default' })] })
    expect(matchVariant(one.variants[0]!, one, product({ region: 'eu', variants: [variant({ sku: 'A-1-EU', title: 'x' })] }))?.sku).toBe('A-1-EU')
    expect(matchVariant(us.variants[0]!, us, nas('eu', '', { variants: [variant({ sku: 'P', title: 'Pink' }), variant({ sku: 'Q', title: 'Teal' })] }))).toBeUndefined()
  })
})

describe('convertPlan', () => {
  const products = [nas('us', ''), nas('eu', '-EU'), nas('jp', ''), product({ region: 'us', id: 'only-us', slug: 'only-us', title: 'US Only', variants: [variant({ sku: 'OU-1' })] })]

  it('moves a line to the same product in the other region, keeping its quantity and dropping the old price', () => {
    const c = convertPlan([line()], {}, products, 'eu')
    expect(c.lines).toEqual([{ ref: 'eu/unas-2', sku: 'UNAS-2-B-EU', qty: 2, addedCents: null }])
    expect(c.outcomes[0]).toMatchObject({ result: 'counterpart', title: 'UNAS 2' })
    expect(c.left).toBe(0)
  })

  it('says so when the SKU is the same, and reports what the region does not sell', () => {
    const c = convertPlan([line(), line({ ref: 'us/only-us', sku: 'OU-1', qty: 1 }), line({ ref: 'us/gone', sku: 'G' })], {}, products, 'jp')
    expect(c.lines.map((l) => l.ref)).toEqual(['jp/unas-2'])
    expect(c.outcomes.map((o) => [o.result, o.why])).toEqual([['same', undefined], ['left', 'not-sold'], ['left', 'untracked']])
    expect(c.left).toBe(2)
  })

  it('reports a product it sells but not in the variant', () => {
    const odd = [nas('us', ''), nas('eu', '', { variants: [variant({ sku: 'P', title: 'Pink' }), variant({ sku: 'Q', title: 'Teal' })] })]
    const c = convertPlan([line()], {}, odd, 'eu')
    expect(c.outcomes[0]).toMatchObject({ result: 'left', why: 'no-variant' })
    expect(c.lines).toEqual([])
  })

  it('finds a product by slug when the ids differ, merges lines that land together, and moves how a switch is powered', () => {
    const slugOnly = [nas('us', ''), nas('uk', '-UK', { id: 'other-id' })]
    const lines = [line({ qty: 1 }), line({ sku: 'UNAS-2-B', qty: 3 })] // the same line twice, as a crafted plan could
    const c = convertPlan(lines, { 'us/unas-2:UNAS-2-B': 7 }, slugOnly, 'uk')
    expect(c.lines).toEqual([{ ref: 'uk/unas-2', sku: 'UNAS-2-B-UK', qty: 4, addedCents: null }])
    expect(c.powering).toEqual({ 'uk/unas-2:UNAS-2-B-UK': 7 })
  })

  it('does not change a plan that is already in the region', () => {
    const c = convertPlan([line()], {}, products, 'us')
    expect(c.lines).toEqual([{ ...line(), addedCents: null }])
    expect(c.outcomes[0]?.result).toBe('same')
  })
})
