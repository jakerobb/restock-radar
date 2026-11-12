import { formatMoney, surchargeBreakdown, totalCents } from '../lib/format'
import type { Variant } from '../api/types'

interface PriceTagProps {
  variant: Pick<Variant, 'price_cents' | 'regular_price_cents' | 'price_with_surcharges_cents' | 'surcharge_types' | 'currency'>
}

/**
 * The price including the store's surcharges, large, with the base price and
 * each surcharge broken out beneath it and in a tooltip.
 */
export function PriceTag({ variant }: PriceTagProps) {
  const total = totalCents(variant)
  const breakdown = surchargeBreakdown(variant)
  const [base, ...surcharges] = breakdown.split('\n')
  const discounted = variant.regular_price_cents !== null && variant.price_cents !== null && variant.regular_price_cents !== variant.price_cents
  return (
    <span className="inline-flex flex-col items-end whitespace-nowrap tabular-nums" title={breakdown || undefined}>
      <span className="text-base font-semibold">
        {/* Without surcharges the regular price is directly comparable; with them it's in the breakdown. */}
        {discounted && !breakdown && <s className="mr-1.5 text-sm font-normal text-muted">{formatMoney(variant.regular_price_cents, variant.currency)}</s>}
        {formatMoney(total, variant.currency)}
      </span>
      {breakdown && (
        <span className="text-xs leading-tight font-normal text-muted">
          <span className="block">{base}</span>
          {surcharges.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}
