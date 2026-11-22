import { setAddOn, variantsByNum, addLine, decodePlan, encodePlan, MAX_SLUG, MAX_NAME, cleanName, changeVariant, defaultVariant, lineFor, lineKey, MAX_LINES, MAX_QTY, parseLine, parsePlan, planTotals, removeLine, serializeLine, setQty, viewLine, type PlanLine } from './plan'
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
  const catalogue = [
    product({ region: 'us', slug: 'usw-pro-max-24-poe', variants: [variant({ num: 12, sku: 'USW-Pro-Max-24-PoE' })] }),
    product({ region: 'us', slug: 'u7-pro', variants: [variant({ num: 130, sku: 'U7-Pro-W' }), variant({ num: 131, sku: 'U7-Pro-B' })] }),
    product({ region: 'eu', slug: 'odd', variants: [variant({ num: 20000, sku: 'A B/C:D' })] }),
  ]
  const lines: PlanLine[] = [
    { ref: 'us/usw-pro-max-24-poe', sku: 'USW-Pro-Max-24-PoE', qty: 2, addedCents: 79900 },
    { ref: 'us/u7-pro', sku: 'U7-Pro-B', qty: 5, addedCents: null },
    { ref: 'eu/odd', sku: 'A B/C:D', qty: 99, addedCents: 100 },
  ]

  it('round-trips, in order, without the price, and is URL-safe', () => {
    const slug = encodePlan(lines, catalogue)
    expect(slug).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodePlan(slug, catalogue)).toEqual({ lines: lines.map((l) => ({ ...l, addedCents: null })), unknown: 0, hosting: {}, powering: {}, name: 'My Plan' })
  })

  it('takes two bytes a line while numbers are small', () => {
    // 12 and 2: 2 bytes. 131 and 5: 3 (131 needs two). 20000 and 99: 4 (20000 needs three). 9 bytes = 12 characters.
    expect(encodePlan(lines, catalogue)).toHaveLength(12)
    expect(encodePlan(lines.slice(0, 1), catalogue)).toHaveLength(3)
  })

  it('leaves out lines that are not in the catalogue, and counts the ones it cannot place', () => {
    const slug = encodePlan([...lines, { ref: 'us/gone', sku: 'G', qty: 1, addedCents: null }], catalogue)
    expect(decodePlan(slug, catalogue)!.lines).toHaveLength(3)
    expect(decodePlan(slug, catalogue.slice(0, 2))).toEqual({ lines: lines.slice(0, 2).map((l) => ({ ...l, addedCents: null })), unknown: 1, hosting: {}, powering: {}, name: 'My Plan' })
  })

  it('merges a repeated variant and holds an empty plan', () => {
    const once = { ...lines[0]!, qty: 1 }
    expect(decodePlan(encodePlan([once, once], catalogue), catalogue)!.lines).toHaveLength(1)
    expect(encodePlan([], catalogue)).toBe('')
  })

  it('refuses what it did not make', () => {
    // A bare number with no quantity, a quantity of 0 or 100, a number of 0, and a number running off the end.
    const bad = ['', 'not a slug', '!!!!', 'a'.repeat(MAX_SLUG + 1), btoa('\x0c'), btoa('\x0c\x00'), btoa('\x0c\x64'), btoa('\x00\x01'), btoa('\x0c\x01\x80')].map((s) => s.replace(/=+$/, ''))
    for (const slug of bad) expect(decodePlan(slug, catalogue), slug).toBeNull()
  })

  it('carries the controllers run elsewhere in the slug, and nothing when there are none', () => {
    const slug = encodePlan(lines, catalogue, { network: 'self', talk: 'self' })
    expect(decodePlan(slug, catalogue)).toMatchObject({ lines: lines.map((l) => ({ ...l, addedCents: null })), unknown: 0, hosting: { network: 'self', talk: 'self' } })
    expect(encodePlan(lines, catalogue, {})).toBe(encodePlan(lines, catalogue))
    expect(decodePlan(encodePlan(lines, catalogue), catalogue)?.hosting).toEqual({})
  })
})

describe('plan names', () => {
  const p = product({ variants: [variant({ sku: 'SKU-1', num: 9 })] })
  const l: PlanLine = { ref: 'us/' + p.slug, sku: 'SKU-1', qty: 2, addedCents: null }

  it('tidies a name and cuts it to 50 characters', () => {
    expect(cleanName('  a \n  b ')).toBe('a b')
    expect(cleanName('x'.repeat(60))).toBe('x'.repeat(MAX_NAME))
    expect(Array.from(cleanName('🙂'.repeat(60)))).toHaveLength(MAX_NAME)
    expect(cleanName(5)).toBe('')
  })

  it('travels in the share link, accents and emoji included', () => {
    for (const name of ['Garage rack', 'Café ünï 🙂', 'x'.repeat(MAX_NAME), '🙂'.repeat(MAX_NAME)]) {
      const slug = encodePlan([l], [p], { network: 'self' }, {}, name)
      expect(slug.length).toBeLessThanOrEqual(MAX_SLUG)
      expect(decodePlan(slug, [p])).toMatchObject({ name, lines: [{ sku: 'SKU-1', qty: 2 }], hosting: { network: 'self' } })
    }
  })

  it('is “My Plan” when the link has none, and a name alone is no link', () => {
    expect(decodePlan(encodePlan([l], [p]), [p])!.name).toBe('My Plan')
    expect(encodePlan([], [p], {}, {}, 'Name')).toBe('')
  })

  it('rejects a name that is cut short', () => {
    const slug = encodePlan([l], [p], {}, {}, 'Garage rack')
    expect(decodePlan(slug.slice(0, 6), [p])).toBeNull()
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
    // It keeps its place in the plan.
    const first = line({ ref: 'us/a' })
    const last = line({ ref: 'us/c' })
    expect(changeVariant([first, line(), last], lineKey(line()), other).map((l) => l.ref)).toEqual(['us/a', 'us/widget', 'us/c'])
  })
})

describe('how switches are powered in a share link', () => {
  it('round-trips with the plan, whichever order it comes in, and is ignored for a line that is not in it', () => {
    const a = product({ slug: 'a', variants: [variant({ sku: 'A', num: 5 })] })
    const b = product({ slug: 'b', variants: [variant({ sku: 'B', num: 6 })] })
    const lines = [line({ ref: 'us/a', sku: 'A' }), line({ ref: 'us/b', sku: 'B', qty: 2 })]
    const powering = { [lineKey(lines[1]!)]: 4242, [lineKey({ ref: 'us/gone', sku: 'G' })]: 7 }
    const decoded = decodePlan(encodePlan(lines, [a, b], {}, powering), [a, b])!
    expect(decoded.powering).toEqual({ [lineKey(lines[1]!)]: 4242 })
    expect(decoded.lines.map((l) => l.qty)).toEqual([1, 2])
    expect(decodePlan(encodePlan(lines, [a, b]), [a, b])!.powering).toEqual({})
  })

  it('refuses a code out of range', () => {
    const a = product({ slug: 'a', variants: [variant({ sku: 'A', num: 5 })] })
    const bytes = [5, 1, 0x85 | 0, 0x80, 0x80, 0x80, 0x02, 0xff, 0xff, 0x7f] // a line, then a power entry whose code is too big
    const slug = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(decodePlan(slug, [a])).toBeNull()
  })
})

describe('variants the store has taken off', () => {
  it('still resolve in an old link, but the listed variant with the same SKU is the one encoded', () => {
    const p = product({ variants: [variant({ sku: 'SKU-1', num: 9 })], retired: [{ num: 4, sku: 'SKU-1' }] })
    expect(variantsByNum([p]).get(4)).toEqual({ ref: 'us/widget', sku: 'SKU-1' })
    const l = line({ sku: 'SKU-1' })
    expect(decodePlan(encodePlan([l], [p]), [p])!.lines.map((x) => x.sku)).toEqual(['SKU-1'])
    expect(encodePlan([l], [p])).toBe(encodePlan([l], [product({ variants: [variant({ sku: 'SKU-1', num: 9 })] })]))
  })
})

describe('products sold with another', () => {
  const gw = product({ slug: 'gw', variants: [variant({ sku: 'GW' })] })
  const a = product({ slug: 'a', variants: [variant({ sku: 'A', price_cents: 100 })] })
  const b = product({ slug: 'b', variants: [variant({ sku: 'B', price_cents: 200 })] })
  const base = [line({ ref: 'us/gw', sku: 'GW' }), line({ ref: 'us/other', sku: 'O' })]
  it('puts the chosen one in, takes the others out, and leaves the rest of the plan alone', () => {
    const withA = setAddOn(base, [a, b], a, 3)
    expect(withA.map((l) => [l.ref, l.qty])).toEqual([['us/gw', 1], ['us/other', 1], ['us/a', 3]])
    expect(setAddOn(withA, [a, b], b, 3).map((l) => l.ref)).toEqual(['us/gw', 'us/other', 'us/b'])
    expect(setAddOn(withA, [a, b], null, 3).map((l) => l.ref)).toEqual(['us/gw', 'us/other'])
    expect(gw.slug).toBe('gw')
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
