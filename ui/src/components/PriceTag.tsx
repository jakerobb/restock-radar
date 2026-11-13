import type { Variant } from '../api/types'
import { formatPrice, onSale, priceLines, priceTitle, totalCents } from '../lib/format'

interface PriceTagProps {
  variant: Pick<Variant, 'price_cents' | 'regular_price_cents' | 'price_with_surcharges_cents' | 'surcharge_types' | 'currency'>
}

/**
 * The price including the store's surcharges, large, with the base price and
 * each surcharge broken out beneath it and in a tooltip.
 */
export function PriceTag({ variant }: PriceTagProps) {
  const lines = priceLines(variant)
  return (
    <span className="inline-flex flex-col items-end whitespace-nowrap tabular-nums" title={lines.length ? priceTitle(variant) : undefined}>
      <span className="text-base font-semibold">
        {/* With surcharges the regular price is in the breakdown; without, it sits right beside the price. */}
        {onSale(variant) && lines.length === 0 && <s className="mr-1.5 text-sm font-normal text-muted">{formatPrice(variant.regular_price_cents, variant.currency)}</s>}
        {formatPrice(totalCents(variant), variant.currency)}
      </span>
      {lines.length > 0 && (
        <span className="text-xs leading-tight font-normal text-muted">
          {lines.map((line) => (
            <span key={line.text} className="block">
              {line.struck ? <s>{line.text}</s> : line.text}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}
