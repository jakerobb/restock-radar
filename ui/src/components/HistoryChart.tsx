import type { HistoryModel, PriceStep } from '../lib/history'
import { dayTicks } from '../lib/history'
import { formatMoney } from '../lib/format'
import { statusInfo } from '../lib/status'
import type { Tone } from './ui/tone'

/** The backdrop for each stock tone. Anything else shows as no data. */
export const stockFill: Record<Tone, string> = {
  ok: 'fill-stock-in',
  bad: 'fill-stock-out',
  warn: 'fill-stock-soon',
  neutral: 'fill-chart-empty',
}

const WIDTH = 600
const HEIGHT = 120
const PLOT = { left: 52, right: 8, top: 8, bottom: 20 }
const TICK_EVERY_DAYS = 5

interface HistoryChartProps {
  model: HistoryModel
  currency: string
  /** Names the chart for assistive tech. */
  label: string
}

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const exactTime = (ms: number) => new Date(ms).toLocaleString()

/** One variant's price (a line) over its stock status (the background colour). */
export function HistoryChart({ model, currency, label }: HistoryChartProps) {
  const { start, end, bands, runs, priceRange } = model
  const plotWidth = WIDTH - PLOT.left - PLOT.right
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom
  const x = (ms: number) => PLOT.left + ((ms - start) / (end - start)) * plotWidth

  // Pad the price range so the line doesn't graze the edges; a flat price gets a band of its own.
  const span = priceRange ? priceRange.max - priceRange.min : 0
  const pad = span > 0 ? span * 0.1 : Math.max((priceRange?.max ?? 0) * 0.05, 50)
  const lo = (priceRange?.min ?? 0) - pad
  const hi = (priceRange?.max ?? 0) + pad
  const y = (cents: number) => PLOT.top + (1 - (cents - lo) / (hi - lo)) * plotHeight

  const days = Math.round((end - start) / 86_400_000)
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label} className="block w-full text-[10px]">
      <rect x={PLOT.left} y={PLOT.top} width={plotWidth} height={plotHeight} className="fill-chart-empty" />
      {bands.map((band) => (
        <rect
          key={band.start}
          x={x(band.start)}
          y={PLOT.top}
          width={x(band.end) - x(band.start)}
          height={plotHeight}
          className={stockFill[statusInfo(band.status).tone]}
        >
          <title>{`${statusInfo(band.status).label}, ${exactTime(band.start)} to ${exactTime(band.end)}`}</title>
        </rect>
      ))}
      <rect x={PLOT.left} y={PLOT.top} width={plotWidth} height={plotHeight} className="fill-none stroke-line" />

      {bands.length === 0 && (
        <text x={PLOT.left + plotWidth / 2} y={PLOT.top + plotHeight / 2} textAnchor="middle" className="fill-muted">
          No data
        </text>
      )}

      {runs.map((run) => (
        <path
          key={run[0]!.start}
          d={stepPath(run, x, y)}
          className="fill-none stroke-chart-ink"
          strokeWidth={1.75}
          strokeLinejoin="round"
        />
      ))}
      {runs.flat().map((step) => (
        // A fat invisible target, so hovering near the line names the price.
        <line
          key={step.start}
          x1={x(step.start)}
          x2={x(step.end)}
          y1={y(step.cents)}
          y2={y(step.cents)}
          stroke="transparent"
          strokeWidth={12}
        >
          <title>{`${formatMoney(step.cents, currency)}, ${exactTime(step.start)} to ${exactTime(step.end)}`}</title>
        </line>
      ))}

      {priceRange && (
        <g className="fill-muted" textAnchor="end">
          <text x={PLOT.left - 4} y={y(priceRange.max) + 3}>
            {formatMoney(priceRange.max, currency)}
          </text>
          {priceRange.min !== priceRange.max && (
            <text x={PLOT.left - 4} y={y(priceRange.min) + 3}>
              {formatMoney(priceRange.min, currency)}
            </text>
          )}
        </g>
      )}

      <g className="fill-muted" textAnchor="middle">
        {dayTicks(end, days, TICK_EVERY_DAYS).map((tick, i, all) => (
          <text
            key={tick}
            x={x(tick)}
            y={HEIGHT - 6}
            textAnchor={i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle'}
          >
            {shortDate(tick)}
          </text>
        ))}
      </g>
    </svg>
  )
}

/** A stepped line: a price holds until it changes, then jumps. */
function stepPath(run: PriceStep[], x: (ms: number) => number, y: (cents: number) => number): string {
  return run
    .map((step, i) => `${i === 0 ? `M${x(step.start)} ${y(step.cents)}` : `V${y(step.cents)}`}H${x(step.end)}`)
    .join('')
}
