import { formatMoney, formatRelative } from './format'

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
