import type { Product } from '../api/types'
import type { CatalogRow } from './catalog'
import { isNvr } from './nvrChecks'
import { lineFor, viewLine } from './plan'
import { planChecks, type DerivedLine } from './planChecks'

/** The most of one NVR we'll suggest buying together. */
export const MAX_NVRS = 4

/** An NVR (or a few of the same) with room for the plan's cameras. */
export interface NvrOption {
  /** Why this one is on the list. */
  label: string
  row: CatalogRow
  qty: number
  /** What the qty cost together, out the door; null when no price is shown. */
  cents: number | null
  currency: string
  inStock: boolean
  /** Camera capacity left over once the plan's cameras are on it, across all the plan's NVRs (0.4 is 40% of one NVR). */
  spare: number
}

export type ListedNvr = Omit<NvrOption, 'label'>

export interface NvrSuggestions {
  options: NvrOption[]
  /** Every NVR that would do, in stock or not, cheapest first. */
  all: ListedNvr[]
}

/**
 * Tries each NVR in the catalogue added to the plan, one and then a few of the same, and keeps those after
 * which the plan's NVR check finds room for every camera (so an NVR already in the plan counts, and so does
 * the PoE one with built-in ports, which takes part in the plan's PoE checks like any switch). Offers the
 * cheapest in stock, the one with the most room to spare (within twice the cheapest), and a cheaper one
 * that isn't in stock. Storage isn't considered.
 */
export function findNvrs(plan: DerivedLine[], rows: CatalogRow[], products: Map<string, Product>): NvrSuggestions {
  const regions = new Set(plan.flatMap((l) => (l.view.product ? [l.view.product.region] : [])))
  const fits: ListedNvr[] = []
  for (const row of rows) {
    if (row.product.category !== 'physical-security-nvr' || !isNvr(row.derived)) continue
    if (regions.size > 0 && !regions.has(row.product.region)) continue
    for (let qty = 1; qty <= MAX_NVRS; qty++) {
      const line = lineFor(row.product, qty)
      if (!line) break
      const view = viewLine(line, products)
      const check = planChecks([...plan, { view, derived: row.derived }]).find((c) => c.id === 'nvr')
      if (!check || check.nvrShortfall || !check.nvr) continue
      fits.push({ row, qty, cents: view.totalCents, currency: view.currency, inStock: view.state === 'in', spare: check.nvr.spare })
      break
    }
  }

  const price = (f: ListedNvr) => f.cents ?? Infinity
  const best = (xs: ListedNvr[], by: (f: ListedNvr) => number) => xs.reduce<ListedNvr | undefined>((a, b) => (a === undefined || by(b) < by(a) ? b : a), undefined)
  const stocked = fits.filter((f) => f.inStock)
  const cheapest = best(stocked, price)
  const picks: [string, ListedNvr | undefined][] = [
    ['Cheapest that fits', cheapest],
    ['Most room to spare', best(stocked.filter((f) => price(f) <= 2 * price(cheapest ?? f)), (f) => -f.spare)],
    ['Cheaper, but not in stock', best(fits.filter((f) => !f.inStock && price(f) < price(cheapest ?? f)), price)],
  ]
  const options: NvrOption[] = []
  for (const [label, fit] of picks) if (fit && !options.some((o) => o.row === fit.row && o.qty === fit.qty)) options.push({ ...fit, label })
  const all = [...fits].sort((a, b) => price(a) - price(b) || a.row.product.title.localeCompare(b.row.product.title))
  return { options, all }
}
