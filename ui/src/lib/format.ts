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

/** Like formatMoney, but whole-dollar amounts drop the ".00": "$175", while "$2.49" keeps its cents. */
export function formatPrice(cents: number | null, currency: string): string {
  if (cents === null) return 'n/a'
  const whole = cents % 100 === 0
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2 }).format(cents / 100)
  } catch {
    return (cents / 100).toFixed(whole ? 0 : 2)
  }
}

export interface PriceLine {
  text: string
  /** Superseded (the pre-sale price); shown struck through. */
  struck?: boolean
}

type Priced = {
  price_cents: number | null
  regular_price_cents: number | null
  price_with_surcharges_cents: number | null
  surcharge_types: string[]
  currency: string
}

/** Whether the variant is on sale: it has a regular price above its current one. */
export function onSale(v: Pick<Priced, 'price_cents' | 'regular_price_cents'>): boolean {
  return v.price_cents !== null && v.regular_price_cents !== null && v.regular_price_cents > v.price_cents
}

/**
 * Breaks a price down: the base price (struck through, with the sale price after it, when on sale), then
 * the surcharges. The store gives only the total, so a lone surcharge type gets its amount and several
 * share their combined amount. Empty when there are no surcharges.
 */
export function priceLines(v: Priced): PriceLine[] {
  const total = totalCents(v)
  if (v.price_cents === null || total === null || total <= v.price_cents) return []
  const money = (c: number) => formatPrice(c, v.currency)
  const amount = money(total - v.price_cents)
  const types = v.surcharge_types.map((t) => t.toLowerCase())
  const surcharge =
    types.length === 1 ? `+ ${amount} ${types[0]} surcharge` : types.length > 1 ? `+ ${amount} surcharges (${types.join(', ')})` : `+ ${amount} surcharges`
  if (onSale(v)) {
    return [{ text: `${money(v.regular_price_cents!)} base price`, struck: true }, { text: `${money(v.price_cents)} sale price` }, { text: surcharge }]
  }
  return [{ text: `${money(v.price_cents)} base price` }, { text: surcharge }]
}

/** The breakdown as plain text for a tooltip; on sale it also says how much was taken off. */
export function priceTitle(v: Priced): string {
  const lines = priceLines(v).map((l) => l.text)
  if (onSale(v) && lines.length > 1) {
    lines[1] += ` (−${formatPrice(v.regular_price_cents! - v.price_cents!, v.currency)})`
  }
  return lines.join('\n')
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
