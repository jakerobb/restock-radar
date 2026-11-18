import type { Product } from '../api/types'
import type { CatalogRow } from './catalog'
import { lineFor, viewLine } from './plan'
import { planChecks, type DerivedLine, type PoeStats } from './planChecks'

/** The most of one switch we'll suggest buying together. */
export const MAX_SWITCHES = 4

/** A switch (or a few of the same) that would make the plan's PoE power and ports work. */
export interface SwitchOption {
  /** Why this one is on the list. */
  label: string
  row: CatalogRow
  qty: number
  /** What the qty cost together, out the door; null when no price is shown. */
  cents: number | null
  currency: string
  inStock: boolean
  stats: PoeStats
  /** True when some device's power draw isn't known, so the fit counts only those that are. */
  partial: boolean
}

export interface SwitchSuggestions {
  options: SwitchOption[]
  /** How many switches in the catalogue would work, in stock or not. */
  fitting: number
}

const hasPoeOut = (r: CatalogRow): boolean => !!r.derived?.known.ports && r.derived.ports.some((p) => p.role === 'data' && p.poe_class !== '' && p.poe_direction === 'out')
const hasBudget = (r: CatalogRow): boolean => (r.derived?.metrics.find((m) => m.name === 'poe_budget_w')?.value ?? 0) > 0

type Fit = Omit<SwitchOption, 'label'>

/**
 * Tries each PoE switch in the catalogue added to the plan, one at a time and then a few of the same,
 * and keeps those after which the plan's PoE power and ports check out (worked out by the same placement
 * the plan page uses, so each switch's own budget counts). Suggests the cheapest that is in stock, the
 * cheapest that runs every device at full speed, and the one with the most room to spare, when those differ.
 * A switch with no known PoE budget is never suggested: unknown is not a fit.
 */
export function findSwitches(plan: DerivedLine[], rows: CatalogRow[], products: Map<string, Product>): SwitchSuggestions {
  const regions = new Set(plan.flatMap((l) => (l.view.product ? [l.view.product.region] : [])))
  const fits: Fit[] = []
  for (const row of rows) {
    if (row.product.type !== 'Switches' || !hasPoeOut(row) || !hasBudget(row)) continue
    if (regions.size > 0 && !regions.has(row.product.region)) continue
    for (let qty = 1; qty <= MAX_SWITCHES; qty++) {
      const line = lineFor(row.product, qty)
      if (!line) break
      const view = viewLine(line, products)
      const checks = planChecks([...plan, { view, derived: row.derived }])
      const power = checks.find((c) => c.id === 'poe-power')
      const ports = checks.find((c) => c.id === 'poe-ports')
      const stats = checks.find((c) => c.id === 'poe-layout')?.stats
      if (!power || !ports || !stats || power.verdict === 'bad' || ports.verdict === 'bad' || stats.stranded > 0) continue
      fits.push({ row, qty, cents: view.totalCents, currency: view.currency, inStock: view.state === 'in', stats, partial: power.verdict === 'unknown' })
      break
    }
  }

  const price = (f: Fit) => f.cents ?? Infinity
  const room = (f: Fit) => (f.stats.spareWatts ?? 0) + f.stats.sparePorts
  const best = (xs: Fit[], by: (f: Fit) => number): Fit | undefined => xs.reduce<Fit | undefined>((a, b) => (a === undefined || by(b) < by(a) ? b : a), undefined)

  const stocked = fits.filter((f) => f.inStock)
  const cheapest = best(stocked, price)
  const picks: [string, Fit | undefined][] = [
    ['Cheapest that fits', cheapest],
    ['Cheapest at full speed', best(stocked.filter((f) => f.stats.slowed === 0), price)],
    // Room to grow, but not at any price: within twice the cheapest.
    ['Most room to spare', best(stocked.filter((f) => price(f) <= 2 * price(cheapest ?? f)), (f) => -room(f))],
    ['Cheaper, but not in stock', best(fits.filter((f) => !f.inStock && price(f) < price(cheapest ?? f)), price)],
  ]
  const options: SwitchOption[] = []
  for (const [label, fit] of picks) {
    if (!fit) continue
    const same = options.find((o) => o.row === fit.row && o.qty === fit.qty)
    if (same) continue
    options.push({ ...fit, label })
  }
  return { options, fitting: fits.length }
}
