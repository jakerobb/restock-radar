import { DEFAULT_HISTORY_DAYS, HISTORY_RANGES, isHistoryRange, readStoredDays, storeDays } from './historyRange'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('history range', () => {
  it('offers 7, 30, 90 and 365 days and defaults to 90', () => {
    expect([...HISTORY_RANGES]).toEqual([7, 30, 90, 365])
    expect(DEFAULT_HISTORY_DAYS).toBe(90)
    expect(readStoredDays()).toBe(90)
  })

  it('remembers a choice', () => {
    storeDays(7)
    expect(readStoredDays()).toBe(7)
  })

  it('ignores stored values that are not an offered range', () => {
    for (const junk of ['0', '45', '-7', 'abc', '']) {
      window.localStorage.setItem('restock-radar.history-days', junk)
      expect(readStoredDays()).toBe(90)
    }
    expect(isHistoryRange(30)).toBe(true)
    expect(isHistoryRange(31)).toBe(false)
  })

  it('falls back quietly when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readStoredDays()).toBe(90)
    expect(() => storeDays(30)).not.toThrow()
  })
})
