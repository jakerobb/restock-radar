/** The history windows a person can choose from, in days. The server caps `days` at 365. */
export const HISTORY_RANGES = [7, 30, 90, 365] as const

export const DEFAULT_HISTORY_DAYS = 90

const STORAGE_KEY = 'restock-radar.history-days'

/** Whether `days` is one of the offered ranges. */
export function isHistoryRange(days: unknown): days is (typeof HISTORY_RANGES)[number] {
  return HISTORY_RANGES.some((r) => r === days)
}

/**
 * The remembered range, or the default. Browser storage can be missing, blocked or
 * hold anything, so every failure falls back quietly.
 */
export function readStoredDays(): number {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY))
    return isHistoryRange(stored) ? stored : DEFAULT_HISTORY_DAYS
  } catch {
    return DEFAULT_HISTORY_DAYS
  }
}

export function storeDays(days: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(days))
  } catch {
    // Not remembered; the choice still applies for this visit.
  }
}
