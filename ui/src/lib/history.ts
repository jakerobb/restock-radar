import type { HistoryResponse, VariantHistory } from '../api/types'

const DAY_MS = 86_400_000

/** A stretch of time (epoch ms) over which a variant had one status. */
export interface StockBand {
  start: number
  end: number
  status: string
}

/** A stretch of time over which a variant had one price. */
export interface PriceStep {
  start: number
  end: number
  cents: number
}

export interface HistoryModel {
  /** The visible window, epoch ms. */
  start: number
  end: number
  /** Time-ordered and non-overlapping; gaps are where nothing is known. */
  bands: StockBand[]
  /**
   * Prices, split into runs at every gap (no data, or no price), so each run
   * is drawn as one unbroken line.
   */
  runs: PriceStep[][]
  /** The price range across the window; null when no price was ever known. */
  priceRange: { min: number; max: number } | null
}

/**
 * Turns a variant's change points into what a chart draws, clipped to the
 * window [windowStart, windowEnd]. Knowledge runs from `from` to `until`; a
 * point's state holds until the next point.
 */
export function buildHistoryModel(history: VariantHistory, windowStart: number, windowEnd: number): HistoryModel {
  const known = { start: Math.max(Date.parse(history.from), windowStart), end: Math.min(Date.parse(history.until), windowEnd) }
  const bands: StockBand[] = []
  const runs: PriceStep[][] = []
  let min = Infinity
  let max = -Infinity

  history.points.forEach((point, i) => {
    const start = Math.max(Date.parse(point.time), known.start)
    const next = history.points[i + 1]
    const end = Math.min(next ? Date.parse(next.time) : known.end, known.end)
    if (!(end > start)) return

    const last = bands[bands.length - 1]
    if (last && last.status === point.status && last.end === start) last.end = end
    else bands.push({ start, end, status: point.status })

    if (point.price_cents === null) return
    const cents = point.price_cents
    min = Math.min(min, cents)
    max = Math.max(max, cents)
    const run = runs[runs.length - 1]
    const prev = run?.[run.length - 1]
    if (run && prev && prev.end === start) run.push({ start, end, cents })
    else runs.push([{ start, end, cents }])
  })

  return { start: windowStart, end: windowEnd, bands, runs, priceRange: runs.length > 0 ? { min, max } : null }
}

/** Epoch ms of the day boundaries `daysAgo` before windowEnd, for axis ticks. */
export function dayTicks(windowEnd: number, days: number, every: number): number[] {
  const ticks: number[] = []
  for (let d = days; d >= 0; d -= every) ticks.push(windowEnd - d * DAY_MS)
  return ticks
}

/** The history response, with variants findable by region and id. */
export interface HistoryIndex {
  start: number
  end: number
  days: number
  variant(region: string, id: string): VariantHistory | undefined
}

export function indexHistory(history: HistoryResponse): HistoryIndex {
  const byKey = new Map(history.variants.map((h) => [`${h.region}/${h.variant_id}`, h]))
  const start = Date.parse(history.since)
  const end = Date.parse(history.until)
  return { start, end, days: Math.round((end - start) / DAY_MS), variant: (region, id) => byKey.get(`${region}/${id}`) }
}
