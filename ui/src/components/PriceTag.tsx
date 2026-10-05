import { formatMoney } from '../lib/format'

interface PriceTagProps {
  cents: number | null
  /** The pre-discount price; shown struck through when it differs from cents. */
  regularCents: number | null
  currency: string
}

export function PriceTag({ cents, regularCents, currency }: PriceTagProps) {
  const discounted = regularCents !== null && cents !== null && regularCents !== cents
  return (
    <span className="whitespace-nowrap tabular-nums">
      {discounted && <s className="mr-1.5 text-muted">{formatMoney(regularCents, currency)}</s>}
      {formatMoney(cents, currency)}
    </span>
  )
}
