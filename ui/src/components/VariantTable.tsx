import type { ReactNode } from 'react'
import type { Variant } from '../api/types'
import { nameIsSku } from '../lib/status'
import { VariantRow } from './VariantRow'

const headerCell = 'pb-1 text-xs font-medium text-muted'

interface VariantTableProps {
  variants: Variant[]
  /** Optionally supplies the chart shown beneath a variant's row. */
  chartFor?: (variant: Variant) => ReactNode
}

export function VariantTable({ variants, chartFor }: VariantTableProps) {
  // A column of nothing but SKUs, or of the same word, tells the reader nothing, so it is left out.
  const named = !variants.every(nameIsSku)
  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr>
          {named && <th className={headerCell}>Variant</th>}
          <th className={headerCell}>Status</th>
          <th className={`${headerCell} text-right`}>Price</th>
          <th className={`${headerCell} hidden text-right sm:table-cell`}>Changed</th>
        </tr>
      </thead>
      <tbody>
        {variants.map((variant) => (
          <VariantRow key={variant.id} variant={variant} named={named} chart={chartFor?.(variant)} />
        ))}
      </tbody>
    </table>
  )
}
