import type { Product } from '../api/types'
import { baseSku, baseSlug, convertPlan, counterpart, matchVariant } from './convertPlan'
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

describe('a region that sells two regional versions of a SKU', () => {
  // The European store lists an EU and a UK plug for one product; the US lists one version.
  const us = product({ region: 'us', id: 'xg', slug: 'usw-pro-xg-8-poe', variants: [variant({ sku: 'USW-Pro-XG-8-PoE', title: 'US Version' })] })
  const eu = product({ region: 'eu', id: 'xg', slug: 'usw-pro-xg-8-poe', variants: [variant({ sku: 'USW-Pro-XG-8-PoE-EU', title: 'EU Version' }), variant({ sku: 'USW-Pro-XG-8-PoE-UK', title: 'UK Version' })] })

  it('takes the one made for that region', () => {
    expect(matchVariant(us.variants[0]!, us, eu, 'eu')?.sku).toBe('USW-Pro-XG-8-PoE-EU')
    expect(matchVariant(us.variants[0]!, us, eu, 'uk')?.sku).toBe('USW-Pro-XG-8-PoE-UK')
  })
  it('takes the one that names no region when none is made for it', () => {
    const mixed = product({ region: 'jp', variants: [variant({ sku: 'USW-Pro-XG-8-PoE' }), variant({ sku: 'USW-Pro-XG-8-PoE-UK' })] })
    expect(matchVariant(us.variants[0]!, us, mixed, 'jp')?.sku).toBe('USW-Pro-XG-8-PoE')
  })
  it('gives up when it still cannot tell', () => {
    const odd = product({ region: 'sg', variants: [variant({ sku: 'USW-Pro-XG-8-PoE-EU', title: 'a' }), variant({ sku: 'USW-Pro-XG-8-PoE-UK', title: 'b' })] })
    expect(matchVariant(us.variants[0]!, us, odd, 'sg')).toBeUndefined()
  })
  it('converts the line, and back again', () => {
    const c = convertPlan([{ ref: 'us/usw-pro-xg-8-poe', sku: 'USW-Pro-XG-8-PoE', qty: 1, addedCents: null }], {}, [us, eu], 'eu')
    expect(c.lines).toEqual([{ ref: 'eu/usw-pro-xg-8-poe', sku: 'USW-Pro-XG-8-PoE-EU', qty: 1, addedCents: null }])
    const back = convertPlan(c.lines, {}, [us, eu], 'us')
    expect(back.lines).toEqual([{ ref: 'us/usw-pro-xg-8-poe', sku: 'USW-Pro-XG-8-PoE', qty: 1, addedCents: null }])
  })
})

describe('a product the store sells separately in each region', () => {
  const tower = (region: string, suffix: string, id: string) =>
    product({ region, id, slug: `ups-tower-${suffix}`, title: 'UPS Tower', variants: [variant({ sku: `UPS-Tower-${suffix.toUpperCase()}` })] })
  const products = [tower('us', 'us', 'a'), tower('eu', 'eu', 'b'), tower('uk', 'uk', 'c')]

  it('is found by its slug bar the region, and its SKU follows', () => {
    expect(baseSlug('ups-tower-eu')).toBe('ups-tower')
    expect(baseSlug('usw-pro-hd-24-poe')).toBe('usw-pro-hd-24-poe')
    const c = convertPlan([{ ref: 'us/ups-tower-us', sku: 'UPS-Tower-US', qty: 2, addedCents: null }], {}, products, 'eu')
    expect(c.lines).toEqual([{ ref: 'eu/ups-tower-eu', sku: 'UPS-Tower-EU', qty: 2, addedCents: null }])
    expect(c.outcomes[0]?.result).toBe('counterpart')
  })
  it('works from a European product to the US one', () => {
    expect(counterpart(products[1]!, 'us', products)?.slug).toBe('ups-tower-us')
  })
  it('falls back to the title, but only for one product', () => {
    const renamed = product({ region: 'br', id: 'z', slug: 'torre-ups', title: 'UPS Tower', variants: [variant({ sku: 'UPS-Tower-BR' })] })
    expect(counterpart(products[0]!, 'br', [...products, renamed])?.slug).toBe('torre-ups')
    const twin = product({ region: 'br', id: 'y', slug: 'torre-ups-2', title: 'UPS Tower' })
    expect(counterpart(products[0]!, 'br', [...products, renamed, twin])).toBeUndefined()
  })
  it('does not take a different product that merely starts the same', () => {
    const hd = product({ region: 'us', id: 'h', slug: 'usw-pro-hd-24', title: 'Switch Pro HD 24' })
    const poe = product({ region: 'eu', id: 'p', slug: 'usw-pro-hd-24-poe', title: 'Switch Pro HD 24 PoE' })
    expect(counterpart(hd, 'eu', [hd, poe])).toBeUndefined()
  })
  it('prefers the slug made for the region when several share a base', () => {
    const a = product({ region: 'eu', id: 'q', slug: 'ups-tower-eu', title: 'UPS Tower' })
    const b = product({ region: 'eu', id: 'r', slug: 'ups-tower-uk', title: 'UPS Tower' })
    expect(counterpart(products[0]!, 'eu', [products[0]!, b, a])?.slug).toBe('ups-tower-eu')
  })
})
