/** Formats minor units (cents) as currency, e.g. 10900 USD -> "$109.00". */
export function formatMoney(cents: number | null, currency: string): string {
  if (cents === null) return 'n/a'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)
  } catch {
    // An empty or unknown currency code.
    return (cents / 100).toFixed(2)
  }
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/** Formats a timestamp relative to now: "just now", "5 minutes ago", "yesterday". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.round((then - now) / 1000)
  if (Math.abs(seconds) < 45) return 'just now'
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? UNITS[UNITS.length - 1]!
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(seconds / size), unit)
}

/** The exact local time, for tooltips. */
export function formatExact(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}
