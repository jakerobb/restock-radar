import type { ReactNode } from 'react'
import type { Variant } from '../api/types'
import { VariantRow } from './VariantRow'

const headerCell = 'pb-1 text-xs font-medium text-muted'

interface VariantTableProps {
  variants: Variant[]
  /** Optionally supplies the chart shown beneath a variant's row. */
  chartFor?: (variant: Variant) => ReactNode
}

export function VariantTable({ variants, chartFor }: VariantTableProps) {
  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr>
          <th className={headerCell}>Variant</th>
          <th className={headerCell}>Status</th>
          <th className={`${headerCell} text-right`}>Price</th>
          <th className={`${headerCell} hidden text-right sm:table-cell`}>Changed</th>
        </tr>
      </thead>
      <tbody>
        {variants.map((variant) => (
          <VariantRow key={variant.id} variant={variant} chart={chartFor?.(variant)} />
        ))}
      </tbody>
    </table>
  )
}
