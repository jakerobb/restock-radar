import { buildCatalog, columnById, defaultColumns, COLUMNS, sortRows, summarizePrice } from './catalog'
import { derived, port, product, variant } from '../test/fixtures'

describe('summarizePrice', () => {
  it('takes the cheapest in-stock variant, out-the-door', () => {
    const p = product({
      variants: [
        variant({ id: 'a', status: 'SoldOut', price_cents: 5000 }),
        variant({ id: 'b', status: 'Available', price_cents: 12000, price_with_surcharges_cents: 12500 }),
        variant({ id: 'c', status: 'Available', price_cents: 13000 }),
      ],
    })
    expect(summarizePrice(p)).toMatchObject({ cents: 12500, stock: 'in', buyable: true, inStock: 2, variants: 3 })
  })

  it('falls back to the cheapest price seen when nothing is in stock', () => {
    const p = product({ variants: [variant({ id: 'a', status: 'SoldOut', price_cents: 5000 }), variant({ id: 'b', status: 'SoldOut', price_cents: 4000 })] })
    expect(summarizePrice(p)).toMatchObject({ cents: 4000, stock: 'out', buyable: false })
  })

  it('reports coming soon, and no price when none is shown', () => {
    const p = product({ variants: [variant({ status: 'ComingSoon', price_cents: null })] })
    expect(summarizePrice(p)).toMatchObject({ cents: null, stock: 'soon', buyable: false })
  })

  it('copes with a product without variants', () => {
    expect(summarizePrice(product({ variants: [] }))).toMatchObject({ cents: null, stock: 'out', variants: 0 })
  })
})

describe('buildCatalog', () => {
  it('joins by region and slug, leaving derived null where there is none', () => {
    const rows = buildCatalog(
      [product({ slug: 'a' }), product({ slug: 'b' }), product({ slug: 'a', region: 'eu' })],
      [derived({ slug: 'a', title: 'A' })],
    )
    expect(rows.map((r) => r.derived?.title ?? null)).toEqual(['A', null, null])
  })
})

describe('columns', () => {
  const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
  const row = (d = derived({ known })) => buildCatalog([product()], [d])[0]!

  it('has unique ids, and a default set for every type that exists', () => {
    expect(new Set(COLUMNS.map((c) => c.id)).size).toBe(COLUMNS.length)
    for (const type of ['Switches', 'WiFi', 'Gateways', 'Cameras & Security', '']) {
      for (const id of defaultColumns(type)) expect(columnById(id), `${type}: ${id}`).toBeDefined()
    }
  })

  it('reads the fastest data port, ignoring console ports and unknown speeds', () => {
    const r = row(derived({ known, ports: [port({ max_speed_mbps: 1000 }), port({ max_speed_mbps: 10000, count: 2 }), port({ role: 'console', max_speed_mbps: 100000 })] }))
    expect(columnById('fastest_port')!.value(r)).toBe(10000)
    expect(columnById('fastest_port')!.format(10000)).toBe('10 GbE')
    expect(columnById('fastest_port')!.format(100)).toBe('100 Mbps')
    expect(columnById('ports')!.value(r)).toBe(10)
    expect(columnById('fastest_port')!.value(row(derived()))).toBeNull()
    expect(columnById('fastest_port')!.value(row(derived({ known, ports: [port({ max_speed_mbps: 0 })] })))).toBeNull()
  })

  it('has coverage columns that say their unit, and shows APs\' coverage by default', () => {
    expect(columnById('coverage_sqft')!.label).toBe('Coverage area (ft²)')
    expect(columnById('coverage_m2')!.label).toBe('Coverage area (m²)')
    expect(columnById('range_m')!.label).toBe('Link range')
    expect(defaultColumns('WiFi')).toContain('coverage_sqft')
    const r = row(derived({ known, metrics: [{ name: 'coverage_sqft', value: 1500, unit: 'ft²', at_least: false, raw: '140 m² (1,500 ft²)' }] }))
    expect(columnById('coverage_sqft')!.value(r)).toBe(1500)
    expect(columnById('coverage_sqft')!.format(1500)).toBe('1500 ft²')
    expect(columnById('coverage_m2')!.value(r)).toBeNull()
  })

  it('counts PoE-out ports only', () => {
    const r = row(derived({ known, ports: [port({ count: 8, poe_class: 'PoE+', poe_direction: 'out' }), port({ count: 1, poe_class: 'PoE++', poe_direction: 'in' }), port({ count: 4 })] }))
    expect(columnById('poe_out_ports')!.value(r)).toBe(8)
  })

  it('reads radios and metrics, and rack height only for rack-mount devices', () => {
    const r = row(
      derived({
        known,
        radios: [
          { band: '5 GHz', tech: 'wifi', antenna_gain_dbi: 6, tx_power_dbm: 26, streams: 2, max_rate_mbps: 1 },
          { band: '6 GHz', tech: 'wifi', antenna_gain_dbi: 5.5, tx_power_dbm: 23, streams: 2, max_rate_mbps: 1 },
        ],
        metrics: [{ name: 'poe_budget_w', value: 150, unit: 'W', at_least: false, raw: '' }],
        rack: { mountable: true, units: 2, full_depth: true },
      }),
    )
    expect(columnById('tx_6ghz')!.value(r)).toBe(23)
    expect(columnById('max_gain')!.value(r)).toBe(6)
    expect(columnById('poe_budget_w')!.value(r)).toBe(150)
    expect(columnById('rack_u')!.value(r)).toBe(2)
    expect(columnById('rack_u')!.value(row())).toBeNull()
  })
})

describe('sortRows', () => {
  const mk = (slug: string, title: string, cents: number | null, budget?: number) =>
    buildCatalog(
      [product({ slug, title, variants: [variant({ price_cents: cents })] })],
      [derived({ slug, metrics: budget === undefined ? [] : [{ name: 'poe_budget_w', value: budget, unit: 'W', at_least: false, raw: '' }] })],
    )[0]!
  const rows = [mk('a', 'Alpha', 300, 100), mk('b', 'Bravo', null), mk('c', 'Charlie', 100, 250), mk('d', 'Delta', 200)]
  const titles = (rs: ReturnType<typeof sortRows>) => rs.map((r) => r.product.title)

  it('sorts by price both ways, rows without one always last', () => {
    expect(titles(sortRows(rows, 'price', 'asc'))).toEqual(['Charlie', 'Delta', 'Alpha', 'Bravo'])
    expect(titles(sortRows(rows, 'price', 'desc'))).toEqual(['Alpha', 'Delta', 'Charlie', 'Bravo'])
  })

  it('sorts by a column, unknowns last, ties by name', () => {
    expect(titles(sortRows(rows, 'poe_budget_w', 'desc'))).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta'])
    expect(titles(sortRows(rows, 'poe_budget_w', 'asc'))).toEqual(['Alpha', 'Charlie', 'Bravo', 'Delta'])
  })

  it('sorts by name, and leaves the input alone', () => {
    const before = titles(rows)
    expect(titles(sortRows(rows, 'name', 'desc'))).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha'])
    expect(titles(rows)).toEqual(before)
  })

  it('treats an unknown sort key as "no value" for everyone, so order falls back to name', () => {
    expect(titles(sortRows(rows, 'nonsense', 'asc'))).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta'])
  })
})
