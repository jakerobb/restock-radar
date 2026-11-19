import type { Product } from '../api/types'
import type { CatalogRow } from './catalog'
import { lineFor, viewLine } from './plan'
import { planChecks, type DerivedLine } from './planChecks'
import { appsRun, fills, HOSTED_ROLES, needers, ROLES, roleCheck, undersized, type HostedRole, type Hosting, type Role } from './roles'

/** One or two products that, added to the plan, fill the roles nothing in it does. */
export interface RoleOption {
  /** Why this one is on the list. */
  label: string
  /** The products to add (one each); two when they are split by role (a gateway and a controller, say). */
  rows: CatalogRow[]
  /** What they cost together, out the door; null when no price is shown. */
  cents: number | null
  currency: string
  inStock: boolean
  /** Products in the plan that fill a role but can't be bought now, or manage fewer devices than the plan has, which these stand in for (the plan is checked without them). */
  replaces: DerivedLine[]
  /** Of those, the ones that are too small (the rest can't be bought). */
  undersized: DerivedLine[]
  /** The roles that were missing and now are filled. */
  covers: Role[]
  /** True when the store doesn't say how many devices a controller manages, so it can't be shown to manage the plan's. */
  unverified: boolean
  /** True for two products that each fill part of it, rather than one that fills it all. */
  split: boolean
}

export type ListedRole = Omit<RoleOption, 'label'>
type Fit = Omit<ListedRole, 'replaces' | 'undersized'>

export interface RoleSuggestions {
  /** What was missing (after leaving out what can't be bought now). */
  missing: Role[]
  /** The missing roles that can be run in the cloud or on your own machine instead of on a product. */
  hostable: HostedRole[]
  options: RoleOption[]
  /** Every product or pair that fills them, in stock or not, cheapest first. */
  all: ListedRole[]
}

const refOf = (r: CatalogRow) => `${r.product.region}/${r.product.slug}`

/**
 * Finds what the plan lacks of the roles it needs (a gateway, a Network controller, an Access or Talk
 * controller; Protect is the NVR check's): each product in the catalogue added to the plan, and pairs of
 * products that fill them between them (a gateway with no controller and a Cloud Key, say), which can undercut
 * the consoles that do both. A product in the plan that can't be bought now, or manages fewer devices than the
 * plan has, doesn't count, and is replaced. The controllers that are still missing can also be run somewhere
 * else (see `hostable`), which isn't a product. Adding a product mustn't leave the switch ports short.
 */
export function findRoles(fullPlan: DerivedLine[], rows: CatalogRow[], products: Map<string, Product>, hosting: Hosting = {}): RoleSuggestions {
  const filling = (l: DerivedLine) => ROLES.some((r) => needers(fullPlan, r).length > 0 && fills(l.view.product?.type, l.derived, r))
  const small = undersized(fullPlan, hosting)
  const replaces = [...new Set([...fullPlan.filter((l) => l.view.state !== 'in' && filling(l)), ...small])]
  const plan = fullPlan.filter((l) => !replaces.includes(l))
  const missingOf = (lines: DerivedLine[]) => roleCheck(lines, hosting).flatMap((c) => (c.roleShortfall ? [c.roleShortfall] : []))
  const missing = missingOf(plan)
  const hostable = missing.filter((r): r is HostedRole => (HOSTED_ROLES as readonly Role[]).includes(r))
  if (missing.length === 0) return { missing, hostable, options: [], all: [] }
  const regions = new Set(plan.flatMap((l) => (l.view.product ? [l.view.product.region] : [])))
  const gone = new Set(replaces.map((l) => l.view.line.ref))

  const cands = rows
    .filter((r) => !gone.has(refOf(r)) && (regions.size === 0 || regions.has(r.product.region)) && missing.some((role) => fills(r.product.type, r.derived, role)))
    .flatMap((row) => {
      const line = lineFor(row.product, 1)
      if (!line) return []
      const view = viewLine(line, products)
      const added: DerivedLine = { view, derived: row.derived }
      const after = roleCheck([...plan, added], hosting)
      // A controller whose capacity the store doesn't state can't be shown to manage the plan's devices: offered, but after those that can.
      const unverified = after.some((c) => c.id.endsWith('-capacity') && c.verdict === 'unknown')
      const left = after.flatMap((c) => (c.roleShortfall ? [c.roleShortfall] : []))
      return [{ row, added, unverified, covers: missing.filter((r) => !left.includes(r)) }]
    })
    .filter((c) => c.covers.length > 0)

  // A console takes a switch port (a gateway needs no uplink), so adding one mustn't leave the ports short that weren't before.
  const short = (lines: DerivedLine[]) => planChecks(lines, hosting).some((c) => c.id === 'net-ports' && (c.verdict === 'bad' || c.shortfall))
  const shortBefore = short(plan)
  const fitOf = (items: typeof cands, split: boolean): Fit | null => {
    const added = items.map((i) => i.added)
    if (!shortBefore && short([...plan, ...added])) return null
    const cents = added.reduce<number | null>((n, a) => (n === null || a.view.totalCents === null ? null : n + a.view.totalCents), 0)
    return { rows: items.map((i) => i.row), unverified: items.some((i) => i.unverified), split, cents, currency: added[0]?.view.currency ?? '', inStock: added.every((a) => a.view.state === 'in'), covers: missing }
  }

  const fits: Fit[] = []
  for (const c of cands) if (c.covers.length === missing.length) {
    const f = fitOf([c], false)
    if (f) fits.push(f)
  }
  // Two products that fill it between them, each needed: a gateway and a Cloud Key can undercut a Dream Machine.
  cands.forEach((a, i) => {
    for (const b of cands.slice(i + 1)) {
      if (!missing.every((r) => a.covers.includes(r) || b.covers.includes(r))) continue
      if (a.covers.every((r) => b.covers.includes(r)) || b.covers.every((r) => a.covers.includes(r))) continue // one of them does it all, or adds nothing
      const f = fitOf([a, b], true)
      if (f) fits.push(f)
    }
  })

  const price = (f: Fit) => f.cents ?? Infinity
  const apps = (f: Fit) => f.rows.reduce((n, r) => n + appsRun(r.derived).length + (r.product.type === 'Gateways' ? 1 : 0), 0)
  const best = (xs: Fit[], by: (f: Fit) => number) => xs.reduce<Fit | undefined>((a, b) => (a === undefined || by(b) < by(a) ? b : a), undefined)
  // Those that can be shown to manage the plan's devices come first; the rest only when there are none (they stay in the full list).
  const verified = fits.filter((f) => !f.unverified)
  const preferred = verified.length > 0 ? verified : fits
  const ones = preferred.filter((f) => !f.split)
  const stocked = (ones.some((f) => f.inStock) ? ones : preferred).filter((f) => f.inStock)
  const cheapest = best(stocked, price)
  const picks: [string, Fit | undefined][] = [
    ['Cheapest that fits', cheapest],
    ['Runs the most applications', best(stocked.filter((f) => price(f) <= 2 * price(cheapest ?? f)), (f) => -apps(f))],
    ['Cheaper, but not in stock', best(preferred.filter((f) => !f.inStock && price(f) < price(cheapest ?? f)), price)],
    ['Cheapest as separate products', best(preferred.filter((f) => f.split && f.inStock), price)],
  ]
  const same = (a: Fit, b: Fit) => a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i])
  const options: RoleOption[] = []
  for (const [label, fit] of picks) if (fit && !options.some((o) => same(o, fit))) options.push({ ...fit, label, replaces, undersized: small })
  const all = fits.map((f) => ({ ...f, replaces, undersized: small })).sort((a, b) => price(a) - price(b) || a.rows[0]!.product.title.localeCompare(b.rows[0]!.product.title))
  return { missing, hostable, options, all }
}
