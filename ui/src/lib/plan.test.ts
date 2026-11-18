import { addLine, decodePlan, encodePlan, MAX_SLUG, changeVariant, defaultVariant, lineFor, lineKey, MAX_LINES, MAX_QTY, parseLine, parsePlan, planTotals, removeLine, serializeLine, setQty, viewLine, type PlanLine } from './plan'
import { product, variant } from '../test/fixtures'

const line = (over: Partial<PlanLine> = {}): PlanLine => ({ ref: 'us/widget', sku: 'SKU-1', qty: 1, addedCents: 10900, ...over })

describe('serialising lines', () => {
  it('round-trips, including a SKU with awkward characters and no price', () => {
    for (const l of [line(), line({ sku: 'A:B/C d%', qty: 12, addedCents: null })]) expect(parseLine(serializeLine(l))).toEqual(l)
  })

  it('refuses anything malformed', () => {
    for (const bad of ['', 'nonsense', 'us/w:SKU:1', 'us/w:SKU:0:1', 'us/w:SKU:100:1', 'us/w:SKU:1.5:1', 'us/w::1:1', 'us/w:SKU:1:-5', 'us/w:SKU:1:abc', 'us/w:%E0%A4%A:1:1', 'a/b/c:SKU:1:1', 42, null, {}]) {
      expect(parseLine(bad), String(bad)).toBeNull()
    }
  })

  it('skips bad and repeated lines in a list, and bounds its length', () => {
    expect(parsePlan(['us/a:S:1:', 'junk', 'us/a:S:5:', 'us/b:S:2:100'])).toEqual([line({ ref: 'us/a', sku: 'S', addedCents: null }), line({ ref: 'us/b', sku: 'S', qty: 2, addedCents: 100 })])
    expect(parsePlan('not a list')).toEqual([])
    expect(parsePlan(Array.from({ length: 300 }, (_, i) => `us/p${i}:S:1:`))).toHaveLength(MAX_LINES)
  })
})

describe('plan slugs', () => {
  const lines: PlanLine[] = [
    { ref: 'us/usw-pro-max-24-poe', sku: 'USW-Pro-Max-24-PoE', qty: 2, addedCents: 79900 },
    { ref: 'us/u7-pro', sku: 'U7-Pro', qty: 5, addedCents: null },
    { ref: 'eu/odd', sku: 'A B/C:D', qty: 1, addedCents: 100 },
  ]

  it('round-trips, in order, and is URL-safe', () => {
    const slug = encodePlan(lines)
    expect(slug).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodePlan(slug)).toEqual(lines)
  })

  it('is shorter than the lines written out', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ref: `us/usw-pro-max-24-poe`, sku: `SKU-${i}`, qty: 1, addedCents: 79900 }))
    expect(encodePlan(many).length).toBeLessThan(many.map(serializeLine).join('&').length / 2)
  })

  it('holds an empty plan', () => {
    expect(decodePlan(encodePlan([]))).toEqual([])
  })

  it('refuses what it did not make', () => {
    for (const bad of ['', 'not a slug', '!!!!', 'AAAA', 'a'.repeat(MAX_SLUG + 1)]) expect(decodePlan(bad)).toBeNull()
  })
})

describe('editing a plan', () => {
  it('adds a line, or raises the quantity of the same product and variant', () => {
    const once = addLine([], line())
    expect(addLine(once, line({ qty: 2 }))).toEqual([line({ qty: 3 })])
    expect(addLine(once, line({ sku: 'SKU-2' }))).toHaveLength(2)
    expect(addLine([line({ qty: MAX_QTY })], line())[0]!.qty).toBe(MAX_QTY)
  })

  it('removes a line by key, and keeps a quantity between 1 and the maximum', () => {
    const plan = [line(), line({ sku: 'SKU-2' })]
    expect(removeLine(plan, lineKey(line()))).toEqual([line({ sku: 'SKU-2' })])
    expect(setQty(plan, lineKey(line()), 0)[0]!.qty).toBe(1)
    expect(setQty(plan, lineKey(line()), 500)[0]!.qty).toBe(MAX_QTY)
    expect(setQty(plan, lineKey(line()), NaN)[0]!.qty).toBe(1)
    expect(setQty(plan, lineKey(line()), 3.6)[0]!.qty).toBe(4)
  })

  it('switches a line to another variant, taking its price, and merges with a line that has it', () => {
    const other = variant({ sku: 'SKU-2', price_cents: 5000 })
    expect(changeVariant([line({ qty: 2 })], lineKey(line()), other)).toEqual([line({ sku: 'SKU-2', qty: 2, addedCents: 5000 })])
    // Merged into the line already there, which keeps its own added price.
    expect(changeVariant([line({ qty: 2 }), line({ sku: 'SKU-2', qty: 1, addedCents: 4000 })], lineKey(line()), other)).toEqual([line({ sku: 'SKU-2', qty: 3, addedCents: 4000 })])
  })
})

describe('what to add for a product', () => {
  it('takes the cheapest variant in stock, else the cheapest, else the first', () => {
    const p = product({
      variants: [variant({ sku: 'out', status: 'SoldOut', price_cents: 1000 }), variant({ sku: 'dear', price_cents: 9000 }), variant({ sku: 'cheap', price_cents: 5000, price_with_surcharges_cents: 5500 })],
    })
    expect(defaultVariant(p)!.sku).toBe('cheap')
    expect(lineFor(p)).toEqual({ ref: 'us/widget', sku: 'cheap', qty: 1, addedCents: 5500 })
    expect(defaultVariant(product({ variants: [variant({ sku: 'a', status: 'SoldOut', price_cents: 3 }), variant({ sku: 'b', status: 'SoldOut', price_cents: 2 })] }))!.sku).toBe('b')
    expect(defaultVariant(product({ variants: [variant({ sku: 'x', price_cents: null, status: 'ComingSoon' })] }))!.sku).toBe('x')
    expect(lineFor(product({ variants: [] }))).toBeNull()
  })
})

describe('pricing a plan against the catalogue', () => {
  const products = new Map([
    ['us/widget', product({ variants: [variant({ sku: 'SKU-1', price_cents: 12000, price_with_surcharges_cents: 12500 }), variant({ sku: 'SKU-2', status: 'SoldOut', price_cents: 8000 }), variant({ sku: 'SKU-3', status: 'ComingSoon', price_cents: null })] })],
  ])

  it('prices a line out the door and notes a change since it was added', () => {
    const v = viewLine(line({ qty: 2, addedCents: 10900 }), products)
    expect(v).toMatchObject({ unitCents: 12500, totalCents: 25000, state: 'in', wasCents: 10900 })
    expect(viewLine(line({ addedCents: 12500 }), products).wasCents).toBeNull()
    expect(viewLine(line({ addedCents: null }), products).wasCents).toBeNull()
  })

  it('tells sold out, coming soon, a vanished variant and an untracked product apart', () => {
    expect(viewLine(line({ sku: 'SKU-2' }), products).state).toBe('out')
    expect(viewLine(line({ sku: 'SKU-3' }), products)).toMatchObject({ state: 'soon', unitCents: null, totalCents: null })
    expect(viewLine(line({ sku: 'GONE' }), products)).toMatchObject({ state: 'unlisted', unitCents: null })
    expect(viewLine(line({ ref: 'us/other' }), products)).toMatchObject({ state: 'untracked', unitCents: null })
  })

  it('totals what is priced, per currency, and reports what isn’t or can’t be bought', () => {
    const eu = new Map([...products, ['eu/widget', product({ region: 'eu', variants: [variant({ sku: 'SKU-1', currency: 'EUR', price_cents: 1000 })] })]])
    const t = planTotals([line({ qty: 2 }), line({ sku: 'SKU-2' }), line({ sku: 'SKU-3' }), line({ ref: 'eu/widget' })].map((l) => viewLine(l, eu)))
    expect(t.sums).toEqual([{ currency: 'USD', cents: 25000 + 8000 }, { currency: 'EUR', cents: 1000 }])
    expect(t).toMatchObject({ unpriced: 1, items: 5 })
    expect(t.notInStock.map((v) => v.line.sku)).toEqual(['SKU-2', 'SKU-3'])
  })
})
