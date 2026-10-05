import type { Variant } from '../api/types'
import { variantName } from '../lib/status'
import { PriceTag } from './PriceTag'
import { RelativeTime } from './RelativeTime'
import { StatusBadge } from './StatusBadge'

export function VariantRow({ variant }: { variant: Variant }) {
  const { title, sku } = variantName(variant)
  return (
    <tr className="border-t border-line align-baseline">
      <td className="py-1.5 pr-2">
        {title}
        {sku && <div className="text-xs text-muted">{sku}</div>}
      </td>
      <td className="py-1.5 pr-2">
        <StatusBadge status={variant.status} />
        {variant.restock_eta && <span className="ml-1.5 text-xs text-muted">restock {variant.restock_eta}</span>}
      </td>
      <td className="py-1.5 text-right">
        <PriceTag cents={variant.price_cents} regularCents={variant.regular_price_cents} currency={variant.currency} />
      </td>
      <td className="hidden py-1.5 pl-2 text-right text-muted sm:table-cell">
        <RelativeTime iso={variant.last_changed} />
      </td>
    </tr>
  )
}
