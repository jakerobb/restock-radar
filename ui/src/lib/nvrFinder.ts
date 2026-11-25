import type { Product } from '../api/types'
import type { CatalogRow } from './catalog'
import { acceptsRow, mountsFor, NO_FILTERS, withMounts, type FinderFilters, type Mount } from './finderFilters'
import { isNvr, type CameraClass } from './nvrChecks'
import { lineFor, viewLine } from './plan'
import { planChecks, type DerivedLine } from './planChecks'

/** An NVR with room for the plan's cameras. */
export interface NvrOption {
  /** Why this one is on the list. */
  label: string
  row: CatalogRow
  /** What the qty cost together, out the door; null when no price is shown. */
  cents: number | null
  currency: string
  inStock: boolean
  /** Rack-mount accessories to buy with it (the rack filter's), already in `cents`. */
  mounts: Mount[]
  /** NVRs in the plan that can't be bought now, which this one stands in for (the plan is checked without them). */
  replaces: DerivedLine[]
  /** True for a gateway or console that also records (a Dream Machine, say), rather than a recorder. */
  alsoGateway: boolean
  /** How many more cameras of the `benchmark` class the plan's NVRs have room for once its cameras are on them. */
  room: number
  /** The class `room` is counted in: the highest resolution among the plan's cameras (4K when none is known). */
  benchmark: CameraClass
}

export type ListedNvr = Omit<NvrOption, 'label'>
type Fit = Omit<ListedNvr, 'replaces'>

export interface NvrSuggestions {
  options: NvrOption[]
  /** Every NVR that would do, in stock or not, cheapest first. */
  all: ListedNvr[]
}

/**
 * Tries each NVR in the catalogue added to the plan, one of it (several NVRs share no facial recognition data or
 * alarm settings, so they aren't suggested), and keeps those after which the plan's NVR check finds room for every
 * camera (so an NVR already in the plan counts, and so does the PoE one with built-in ports, which takes part in
 * the plan's PoE checks like any switch). Offers the cheapest in stock and a cheaper one that isn't in stock. A
 * gateway or console that records too (a Dream Machine) is a candidate. An NVR in the plan that can't be bought
 * now is checked without and replaced. Storage isn't considered.
 */
export function findNvrs(fullPlan: DerivedLine[], rows: CatalogRow[], products: Map<string, Product>, filters: FinderFilters = NO_FILTERS): NvrSuggestions {
  // An NVR that can't be bought now gives nothing to count on, so the plan is checked without it and stand-ins offered.
  const replaces = fullPlan.filter((l) => isNvr(l.derived) && l.view.state !== 'in')
  const plan = fullPlan.filter((l) => !replaces.includes(l))
  const fits: Fit[] = []
  for (const row of rows) {
    if (!isNvr(row.derived) || replaces.some((l) => l.view.line.ref === `${row.product.region}/${row.product.slug}`)) continue
    const alsoGateway = row.product.category !== 'physical-security-nvr'
    if (!acceptsRow(row, filters, products)) continue
    const line = lineFor(row.product, 1)
    if (!line) continue
    const view = viewLine(line, products)
    const check = planChecks([...plan, { view, derived: row.derived }]).find((c) => c.id === 'nvr')
    if (!check || check.nvrShortfall || !check.nvr) continue
    const mounts = mountsFor(row, 1, filters, products)
    const priced = withMounts(view.totalCents, view.state === 'in', mounts)
    if (filters.inStock && !priced.inStock) continue // what can't be bought now isn't offered
    fits.push({ row, mounts, ...priced, currency: view.currency, alsoGateway, room: check.nvr.room, benchmark: check.nvr.benchmark })
  }

  const price = (f: Fit) => f.cents ?? Infinity
  const best = (xs: Fit[], by: (f: Fit) => number) => xs.reduce<Fit | undefined>((a, b) => (a === undefined || by(b) < by(a) ? b : a), undefined)
  const stocked = fits.filter((f) => f.inStock)
  const cheapest = best(stocked, price)
  const picks: [string, Fit | undefined][] = [
    ['Cheapest that fits', cheapest],
    ['Cheaper, but not in stock', best(fits.filter((f) => !f.inStock && price(f) < price(cheapest ?? f)), price)],
  ]
  const options: NvrOption[] = []
  for (const [label, fit] of picks) if (fit && !options.some((o) => o.row === fit.row)) options.push({ ...fit, label, replaces })
  const all = fits.map((f) => ({ ...f, replaces })).sort((a, b) => price(a) - price(b) || a.row.product.title.localeCompare(b.row.product.title))
  return { options, all }
}
