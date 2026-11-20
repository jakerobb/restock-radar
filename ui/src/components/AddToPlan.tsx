import { Link } from '@tanstack/react-router'
import type { Product } from '../api/types'
import { usePlan } from '../hooks/usePlan'
import { lineFor } from '../lib/plan'
import { productRef } from '../lib/compare'
import { cn } from '../lib/cn'

/** Adds a product to the build plan (its cheapest variant in stock; the plan page lets you change that). */
export function AddToPlan({ product, className }: { product: Product; className?: string }) {
  const { lines, add, name } = usePlan()
  const line = lineFor(product)
  if (!line) return null
  const inPlan = lines.filter((l) => l.ref === productRef(product)).reduce((n, l) => n + l.qty, 0)
  const look = 'cursor-pointer text-sm text-muted underline underline-offset-2 hover:text-ink'
  return (
    <span className={cn('inline-flex items-baseline gap-2', className)}>
      <button type="button" className={look} onClick={() => add(line)} aria-label={`Add ${product.title} to the plan`} title={`Adds to “${name}”`}>
        {inPlan > 0 ? 'Add another' : 'Add to plan'}
      </button>
      {inPlan > 0 && (
        <Link to="/plan" className="text-sm text-accent underline-offset-2 hover:underline">
          In plan ({inPlan})
        </Link>
      )}
    </span>
  )
}
