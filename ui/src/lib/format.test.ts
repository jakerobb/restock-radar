import { formatMoney, formatRelative, surchargeBreakdown, totalCents } from './format'

describe('formatMoney', () => {
  it('formats minor units as currency', () => {
    expect(formatMoney(10900, 'USD')).toMatch(/\$109\.00/)
  })
  it('handles a missing price', () => {
    expect(formatMoney(null, 'USD')).toBe('n/a')
  })
  it('survives a currency code it does not know', () => {
    expect(formatMoney(250, '')).toBe('2.50')
  })
})

describe('formatRelative', () => {
  const now = new Date('2026-10-05T12:00:00Z').getTime()
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()

  it('says "just now" for the last few seconds', () => {
    expect(formatRelative(ago(10), now)).toBe('just now')
  })
  it('uses the largest fitting unit', () => {
    expect(formatRelative(ago(5 * 60), now)).toMatch(/5 minutes ago/)
    expect(formatRelative(ago(3 * 3600), now)).toMatch(/3 hours ago/)
    expect(formatRelative(ago(2 * 86400), now)).toMatch(/2 days ago/)
  })
  it('reads the future too', () => {
    expect(formatRelative(new Date(now + 2 * 3600 * 1000).toISOString(), now)).toMatch(/in 2 hours/)
  })
  it('returns nothing for garbage', () => {
    expect(formatRelative('not a date', now)).toBe('')
  })
})

describe('surcharges', () => {
  const base = { price_cents: 129900, regular_price_cents: null, price_with_surcharges_cents: 143100, surcharge_types: ['Memory'], currency: 'USD' }

  it('uses the price with surcharges as the total', () => {
    expect(totalCents(base)).toBe(143100)
    expect(totalCents({ ...base, price_with_surcharges_cents: null })).toBe(129900)
    expect(totalCents({ ...base, price_cents: null })).toBeNull()
  })

  it('breaks down a single surcharge', () => {
    expect(surchargeBreakdown(base)).toBe('$1,299.00 base price\n+ $132.00 memory surcharge')
  })

  it('names every type when only the combined amount is known', () => {
    expect(surchargeBreakdown({ ...base, surcharge_types: ['Memory', 'Tariff'] })).toBe('$1,299.00 base price\n+ $132.00 surcharges (memory, tariff)')
  })

  it('is empty without a surcharge', () => {
    expect(surchargeBreakdown({ ...base, price_with_surcharges_cents: 129900, surcharge_types: [] })).toBe('')
    expect(surchargeBreakdown({ ...base, price_with_surcharges_cents: null })).toBe('')
  })
})
