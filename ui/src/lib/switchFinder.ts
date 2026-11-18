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
  /** Switches in the plan that can't be bought now, which this one stands in for (the plan is checked without them). */
  replaces: DerivedLine[]
  /** True when some device's power draw isn't known, so the fit counts only those that are. */
  partial: boolean
}

/** A switch that works, without the reason it was picked. */
export type ListedSwitch = Omit<SwitchOption, 'label'>

export interface SwitchSuggestions {
  options: SwitchOption[]
  /** Every acceptable switch that would work, in stock or not, cheapest first. */
  all: ListedSwitch[]
  /** Switches that would work but run on a power method that isn't accepted. */
  hidden: number
}

/** The ways of powering a switch a buyer can accept or rule out. Backup supplies (RPS, battery) aren't one. */
export type PowerMethod = 'ac' | 'dc' | 'poe'
export const POWER_METHODS: readonly { id: PowerMethod; label: string }[] = [
  { id: 'ac', label: 'AC' },
  { id: 'dc', label: 'DC' },
  { id: 'poe', label: 'PoE' },
]
/** What most people have to hand: mains and a PoE injector or switch upstream. */
export const DEFAULT_POWER_METHODS: readonly PowerMethod[] = ['ac', 'poe']

const METHOD_OF: Record<string, PowerMethod | undefined> = { ac: 'ac', dc: 'dc', poe: 'poe', passive_poe: 'poe' }

/** True when the switch can run on at least one of the accepted methods. One that doesn't say how it is powered is not accepted. */
export const acceptsPower = (r: CatalogRow, accepted: ReadonlySet<PowerMethod>): boolean => (r.derived?.power ?? []).some((s) => {
  const m = METHOD_OF[s.kind]
  return m !== undefined && accepted.has(m)
})

const hasPoeOut = (r: CatalogRow): boolean => !!r.derived?.known.ports && r.derived.ports.some((p) => p.role === 'data' && p.poe_class !== '' && p.poe_direction === 'out')
const hasBudget = (r: CatalogRow): boolean => (r.derived?.metrics.find((m) => m.name === 'poe_budget_w')?.value ?? 0) > 0

type Fit = Omit<SwitchOption, 'label' | 'replaces'>

export interface Fits {
  fits: Fit[]
  /** The plan's switches that can't be bought now; the fits were worked out without them. */
  replaces: DerivedLine[]
}

/**
 * Tries each PoE switch in the catalogue added to the plan, one at a time and then a few of the same,
 * and keeps those after which the plan's PoE power and ports check out (worked out by the same placement
 * the plan page uses, so each switch's own budget counts). Suggests the cheapest that is in stock, the
 * cheapest that runs every device at full speed, and the one with the most room to spare, when those differ.
 * A switch with no known PoE budget is never suggested: unknown is not a fit. Nor is one that leaves a device
 * below 1 GbE (or below its own speed, if lower), and when the plan only falls short on speed, one that doesn't
 * speed anything up.
 */
export function findFits(fullPlan: DerivedLine[], rows: CatalogRow[], products: Map<string, Product>): Fits {
  // A switch that can't be bought now gives nothing to count on, so it is checked without and its stand-ins offered.
  const replaces = fullPlan.filter((l) => l.view.state !== 'in' && !!l.derived?.known.ports && l.derived.ports.some((p) => p.role === 'data' && p.poe_class !== '' && p.poe_direction === 'out'))
  const plan = fullPlan.filter((l) => !replaces.includes(l))
  // When the plan only falls short on speed, a switch has to speed devices up to be worth suggesting.
  const before = planChecks(plan)
  const speedOnly = before.some((c) => c.id === 'poe-power' && c.verdict === 'ok') && before.some((c) => c.id === 'poe-ports' && c.verdict === 'ok')
  const slowedBefore = speedOnly ? (before.find((c) => c.id === 'poe-layout')?.stats?.slowed ?? 0) : 0
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
      // Never recommend a switch that leaves devices crawling (an access point on a 100 Mbps port), however cheap.
      if (stats.crawling > 0 || (slowedBefore > 0 && stats.slowed >= slowedBefore)) continue
      fits.push({ row, qty, cents: view.totalCents, currency: view.currency, inStock: view.state === 'in', stats, partial: power.verdict === 'unknown' })
      break
    }
  }

  return { fits, replaces }
}

/** From the fits that run on an accepted power method, the few worth a look and the full list; and how many were left out. */
export function pickOptions({ fits: every, replaces }: Fits, accepted: ReadonlySet<PowerMethod>): SwitchSuggestions {
  const fits = every.filter((f) => acceptsPower(f.row, accepted))
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
    options.push({ ...fit, label, replaces })
  }
  const all = fits.map((f) => ({ ...f, replaces })).sort((a, b) => price(a) - price(b) || a.row.product.title.localeCompare(b.row.product.title))
  return { options, all, hidden: every.length - fits.length }
}

/** Both steps at once, for when the power methods are settled. */
export const findSwitches = (plan: DerivedLine[], rows: CatalogRow[], products: Map<string, Product>, accepted: ReadonlySet<PowerMethod> = new Set<PowerMethod>(['ac', 'dc', 'poe'])): SwitchSuggestions => pickOptions(findFits(plan, rows, products), accepted)
