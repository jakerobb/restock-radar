import type { Product } from '../api/types'
import type { CatalogRow } from './catalog'
import { isInjector } from './injectors'
import { lineFor, viewLine } from './plan'
import { planChecks, type DerivedLine, type Trace } from './planChecks'
import { assumeBest, type Powering } from './powering'

/** The most of one injector (or of each of two) we'll suggest buying together. */
export const MAX_INJECTORS = 12

/** One or two kinds of PoE injector that, added to the plan, power every device the switches can't. */
export interface InjectorOption {
  /** Why this one is on the list. */
  label: string
  /** What to buy: one model, or two (a PoE+ one for the cameras and a PoE++ one for the access point). */
  adds: { row: CatalogRow; qty: number }[]
  /** What it cost together, out the door; null when no price is shown. */
  cents: number | null
  currency: string
  inStock: boolean
  /** Devices that end up on an injector slower than their own port; zero for every option that is listed first. */
  slowed: number
  /** Injectors in the plan that can't be bought now, which these stand in for (the plan is checked without them). */
  replaces: DerivedLine[]
}

export type ListedInjector = Omit<InjectorOption, 'label'>
type Fit = Omit<ListedInjector, 'replaces'>

export interface InjectorSuggestions {
  /** How many devices have no port or power on a switch (and none on an injector already in the plan). */
  devices: number
  options: InjectorOption[]
  /** Every injector (or pair) that would do, in stock or not, cheapest first. */
  all: ListedInjector[]
  /** True when the options are all slower than some device could run, because no injector at full speed would do. */
  slow: boolean
  /** Injectors in the plan that can't be bought now; the options were worked out without them. */
  replaces: DerivedLine[]
}

/**
 * Finds PoE injectors for the devices that no switch in the plan can power, either because the port is of too low a
 * class (or isn't PoE at all) or because the switch's budget is spent. Each candidate is added to the plan, one to
 * as many as there are devices, and kept when the plan's own checks then find power, a high enough class and a switch
 * port for every injector (an injector is a device that has to be plugged in too). One that would hold a device
 * back to a slower speed than its own is kept apart; so is an injector that can't be bought now. Two different
 * injectors are tried only where neither does alone, say a PoE+ one for the cameras and a PoE++ one for the access point.
 * An injector already in the plan counts, and one that can't be bought now is checked without and replaced.
 */
export function findInjectors(fullPlan: DerivedLine[], rows: CatalogRow[], products: Map<string, Product>, powering: Powering = {}): InjectorSuggestions {
  const replaces = fullPlan.filter((l) => isInjector(l.derived) && l.view.state !== 'in')
  const plan = fullPlan.filter((l) => !replaces.includes(l))
  // A switch whose power hasn't been chosen is taken to run on its best input, here: the finder is asked about injectors, not that.
  const powered = (lines: DerivedLine[]): Powering => ({ ...assumeBest(lines), ...powering })
  const before: Trace = {}
  planChecks(plan, {}, powered(plan), before)
  const devices = before.poeLost?.length ?? 0
  if (devices === 0) return { devices, options: [], all: [], slow: false, replaces }
  const regions = new Set(plan.flatMap((l) => (l.view.product ? [l.view.product.region] : [])))
  const cands = rows.filter((r) => isInjector(r.derived) && (regions.size === 0 || regions.has(r.product.region)))

  const tryAdd = (adds: { row: CatalogRow; qty: number }[]): Fit | null => {
    const added: DerivedLine[] = []
    let cents: number | null = 0
    let inStock = true
    let currency = ''
    for (const a of adds) {
      const line = lineFor(a.row.product, a.qty)
      if (!line) return null
      const view = viewLine(line, products)
      added.push({ view, derived: a.row.derived })
      cents = cents === null || view.totalCents === null ? null : cents + view.totalCents
      inStock &&= view.state === 'in'
      currency = view.currency
    }
    const all = [...plan, ...added]
    const trace: Trace = {}
    const checks = planChecks(all, {}, powered(all), trace)
    const power = checks.find((c) => c.id === 'poe-power')
    const ports = checks.find((c) => c.id === 'poe-ports')
    const stats = checks.find((c) => c.id === 'poe-layout')?.stats
    if (!power || !ports || !stats || power.verdict === 'bad' || ports.verdict === 'bad' || stats.stranded > 0) return null
    // Each injector takes a switch port, and none may be left without one.
    const net = checks.find((c) => c.id === 'net-ports')
    if (!net || net.verdict === 'bad' || net.shortfall) return null
    const slowed = (trace.poeHosts ?? []).filter((h) => isInjector(h.host.line.derived) && h.link.speed < h.link.capable).length
    return { adds, cents, currency, inStock, slowed }
  }

  const fits: Fit[] = []
  const alone: number[] = [] // the fewest of each candidate that works by itself
  cands.forEach((row, i) => {
    alone[i] = Infinity
    for (let qty = 1; qty <= Math.min(devices, MAX_INJECTORS); qty++) {
      const fit = tryAdd([{ row, qty }])
      if (fit) {
        fits.push(fit)
        alone[i] = qty
        break
      }
    }
  })
  // Two different injectors, for when devices of different classes make one model either too weak or dear.
  cands.forEach((first, i) => {
    cands.forEach((second, j) => {
      if (j <= i || first.product.region !== second.product.region) return
      const found: [number, number][] = []
      for (let a = 1; a < devices; a++) {
        for (let b = 1; a + b <= devices; b++) {
          if ((alone[i] ?? Infinity) <= a || (alone[j] ?? Infinity) <= b || found.some(([x, y]) => x <= a && y <= b)) continue
          const fit = tryAdd([{ row: first, qty: a }, { row: second, qty: b }])
          if (fit) {
            fits.push(fit)
            found.push([a, b])
          }
        }
      }
    })
  })

  const price = (f: Fit) => f.cents ?? Infinity
  const best = (xs: Fit[], by: (f: Fit) => number) => xs.reduce<Fit | undefined>((a, b) => (a === undefined || by(b) < by(a) ? b : a), undefined)
  // Enough speed is what is asked for; a slower injector is offered only when no other would do.
  const full = fits.filter((f) => f.slowed === 0)
  const pool = full.length > 0 ? full : fits
  const stocked = pool.filter((f) => f.inStock)
  const cheapest = best(stocked, price)
  const picks: [string, Fit | undefined][] = [
    [full.length > 0 ? 'Cheapest that fits' : 'Cheapest, though slower than the devices', cheapest],
    ['Cheaper, but not in stock', best(pool.filter((f) => !f.inStock && price(f) < price(cheapest ?? f)), price)],
  ]
  const options: InjectorOption[] = []
  for (const [label, fit] of picks) if (fit) options.push({ ...fit, label, replaces })
  const all = pool.map((f) => ({ ...f, replaces })).sort((a, b) => price(a) - price(b) || a.adds[0]!.row.product.title.localeCompare(b.adds[0]!.row.product.title))
  return { devices, options, all, slow: full.length === 0 && fits.length > 0, replaces }
}
