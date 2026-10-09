import type { VariantHistory } from '../api/types'
import { buildHistoryModel, dayTicks, indexHistory } from './history'

const t = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString()
const ms = (day: number) => Date.UTC(2026, 9, day)

function history(overrides: Partial<VariantHistory>): VariantHistory {
  return { region: 'us', variant_id: 'v1', from: t(1), until: t(20), points: [], ...overrides }
}

describe('buildHistoryModel', () => {
  it('turns change points into bands and a price line', () => {
    const m = buildHistoryModel(
      history({
        points: [
          { time: t(1), status: 'SoldOut', price_cents: 10000 },
          { time: t(10), status: 'Available', price_cents: 10000 },
          { time: t(15), status: 'Available', price_cents: 9000 },
        ],
      }),
      ms(1),
      ms(20),
    )
    expect(m.bands).toEqual([
      { start: ms(1), end: ms(10), status: 'SoldOut' },
      { start: ms(10), end: ms(20), status: 'Available' },
    ])
    expect(m.runs).toHaveLength(1)
    expect(m.runs[0]!.map((s) => s.cents)).toEqual([10000, 10000, 9000])
    expect(m.priceRange).toEqual({ min: 9000, max: 10000 })
  })

  it('leaves the time before the first sighting and after the last check empty', () => {
    const m = buildHistoryModel(
      history({ from: t(5), until: t(12), points: [{ time: t(5), status: 'Available', price_cents: 500 }] }),
      ms(1),
      ms(20),
    )
    expect(m.bands).toEqual([{ start: ms(5), end: ms(12), status: 'Available' }])
    expect(m.runs[0]![0]).toMatchObject({ start: ms(5), end: ms(12) })
  })

  it('clips a state that began before the window', () => {
    const m = buildHistoryModel(
      history({ from: t(1), points: [{ time: t(1), status: 'Available', price_cents: 500 }] }),
      ms(10),
      ms(20),
    )
    expect(m.bands).toEqual([{ start: ms(10), end: ms(20), status: 'Available' }])
  })

  it('breaks the line where there is no price', () => {
    const m = buildHistoryModel(
      history({
        points: [
          { time: t(1), status: 'Available', price_cents: 500 },
          { time: t(8), status: 'Available', price_cents: null },
          { time: t(12), status: 'Available', price_cents: 600 },
        ],
      }),
      ms(1),
      ms(20),
    )
    expect(m.bands).toHaveLength(1)
    expect(m.runs).toHaveLength(2)
  })

  it('has no price range when no price is known', () => {
    const m = buildHistoryModel(history({ points: [{ time: t(1), status: 'SoldOut', price_cents: null }] }), ms(1), ms(20))
    expect(m.runs).toEqual([])
    expect(m.priceRange).toBeNull()
  })

  it('is empty for a variant first seen after the window', () => {
    const m = buildHistoryModel(
      history({ from: t(25), until: t(26), points: [{ time: t(25), status: 'Available', price_cents: 1 }] }),
      ms(1),
      ms(20),
    )
    expect(m.bands).toEqual([])
  })
})

describe('dayTicks', () => {
  it('counts back from the end of the window', () => {
    expect(dayTicks(ms(30), 30, 10)).toEqual([ms(0), ms(10), ms(20), ms(30)])
  })
})

describe('indexHistory', () => {
  it('finds a variant by region and id, and reports the window', () => {
    const h = history({ region: 'us', variant_id: 'v1' })
    const index = indexHistory({ since: t(1), until: t(31), variants: [h] })
    expect(index.variant('us', 'v1')).toBe(h)
    expect(index.variant('eu', 'v1')).toBeUndefined()
    expect(index.days).toBe(30)
    expect(index.end).toBe(ms(31))
  })
})
