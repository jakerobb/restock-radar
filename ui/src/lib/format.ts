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

/** What a variant costs once the store's surcharges are added; the base price when it has none. */
export function totalCents(v: { price_cents: number | null; price_with_surcharges_cents: number | null }): number | null {
  return v.price_cents === null ? null : (v.price_with_surcharges_cents ?? v.price_cents)
}

/**
 * Breaks a price down for a tooltip: the base price, then the surcharges. The
 * store gives only the total, so a lone surcharge type gets its amount and several
 * share their combined amount. Empty when there are no surcharges.
 */
export function surchargeBreakdown(
  v: { price_cents: number | null; regular_price_cents: number | null; price_with_surcharges_cents: number | null; surcharge_types: string[]; currency: string },
): string {
  const total = totalCents(v)
  if (v.price_cents === null || total === null || total <= v.price_cents) return ''
  const amount = formatMoney(total - v.price_cents, v.currency)
  const types = v.surcharge_types.map((t) => t.toLowerCase())
  const was = v.regular_price_cents !== null && v.regular_price_cents !== v.price_cents ? ` (was ${formatMoney(v.regular_price_cents, v.currency)})` : ''
  const line =
    types.length === 1 ? `+ ${amount} ${types[0]} surcharge` : types.length > 1 ? `+ ${amount} surcharges (${types.join(', ')})` : `+ ${amount} surcharges`
  return `${formatMoney(v.price_cents, v.currency)} base price${was}\n${line}`
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
