import type { Derived } from '../api/types'
import type { LineView } from './plan'
import { POE_CLASSES } from './requirements'

/** What a check found. 'info' is a fact with nothing to judge it against. */
export type CheckVerdict = 'ok' | 'bad' | 'unknown' | 'info'

export interface PlanCheck {
  id: string
  label: string
  verdict: CheckVerdict
  text: string
}

/** A line with what is derived from its product's specification. */
export interface DerivedLine {
  view: LineView
  derived: Derived | null
}

const name = (l: DerivedLine) => l.view.product?.title ?? l.view.line.ref
const metric = (d: Derived | null, n: string): number | null => {
  const v = d?.metrics.find((m) => m.name === n)?.value
  return typeof v === 'number' && v > 0 ? v : null
}
const dataPorts = (d: Derived) => d.ports.filter((p) => p.role === 'data')
/** Ports that take power in (an AP, a camera) and ports that give it out (a PoE switch). */
const poePortsIn = (d: Derived) => dataPorts(d).filter((p) => p.poe_class !== '' && p.poe_direction === 'in')
const poePortsOut = (d: Derived) => dataPorts(d).filter((p) => p.poe_class !== '' && p.poe_direction === 'out')
const list = (ls: DerivedLine[]) => ls.map(name).join(', ')

const rank = (c: string) => POE_CLASSES.indexOf(c as (typeof POE_CLASSES)[number]) + 1
const lowest = (classes: string[]): string => classes.reduce((a, b) => (rank(b) < rank(a) ? b : a))

/**
 * The PoE class a product needs to be powered, or null when it isn't a PoE-powered device. The ports say
 * so when the store marks one as taking PoE in. Many products (access points, mostly) give no such port
 * and only say "Power Method: PoE++", so that counts too, unless another way of powering it is listed
 * (an AC adapter), since then it needs no PoE at all.
 */
function poeNeed(d: Derived): string | null {
  const inPorts = d.known.ports ? poePortsIn(d) : []
  if (inPorts.length > 0) return lowest(inPorts.map((p) => p.poe_class))
  const power = d.power ?? []
  const onlyPoE = power.length > 0 && power.every((s) => s.kind === 'poe' || s.kind === 'passive_poe')
  const classes = power.filter((s) => s.kind === 'poe' && s.poe_class !== '').map((s) => s.poe_class)
  return onlyPoE && classes.length > 0 ? lowest(classes) : null
}

/** "6 PoE++ and 2 PoE", highest class first. */
const byClass = (counts: Map<string, number>): string =>
  [...counts]
    .sort((a, b) => rank(b[0]) - rank(a[0]))
    .map(([c, n]) => `${n} ${c}`)
    .join(' and ')

/** Fits devices to ports: each device takes the lowest class of port that can power it. Returns how many have no port. */
function unplaced(need: Map<string, number>, have: Map<string, number>): number {
  const left = new Map(have)
  let lost = 0
  for (const [cls, n] of [...need].sort((a, b) => rank(b[0]) - rank(a[0]))) {
    for (let i = 0; i < n; i++) {
      const fit = [...left].filter(([c, k]) => rank(c) >= rank(cls) && k > 0).sort((a, b) => rank(a[0]) - rank(b[0]))[0]
      if (fit) left.set(fit[0], fit[1] - 1)
      else lost++
    }
  }
  return lost
}

function poeCheck(lines: DerivedLine[]): PlanCheck[] {
  const needs = new Map(lines.map((l) => [l, l.derived ? poeNeed(l.derived) : null] as const))
  const consumers = lines.filter((l) => needs.get(l) !== null && needs.get(l) !== undefined)
  const suppliers = lines.filter((l) => l.derived?.known.ports && poePortsOut(l.derived!).length > 0)
  if (consumers.length === 0 && suppliers.length === 0) return []
  const qty = (l: DerivedLine) => l.view.line.qty

  const noDraw = consumers.filter((l) => metric(l.derived, 'power_draw_max_w') === null)
  const noBudget = suppliers.filter((l) => metric(l.derived, 'poe_budget_w') === null)
  const demand = consumers.reduce((n, l) => n + qty(l) * (metric(l.derived, 'power_draw_max_w') ?? 0), 0)
  const supply = suppliers.reduce((n, l) => n + qty(l) * (metric(l.derived, 'poe_budget_w') ?? 0), 0)
  const devices = consumers.reduce((n, l) => n + qty(l), 0)
  const need = new Map<string, number>()
  for (const l of consumers) need.set(needs.get(l)!, (need.get(needs.get(l)!) ?? 0) + qty(l))
  const have = new Map<string, number>()
  for (const l of suppliers) for (const p of poePortsOut(l.derived!)) have.set(p.poe_class, (have.get(p.poe_class) ?? 0) + qty(l) * p.count)
  const sockets = [...have.values()].reduce((a, b) => a + b, 0)
  const out: PlanCheck[] = []

  if (suppliers.length === 0) {
    out.push({ id: 'poe-power', label: 'PoE power', verdict: 'info', text: `${devices} PoE-powered ${devices === 1 ? 'device needs' : 'devices need'} up to ${demand} W (${byClass(need)}); nothing in the plan supplies PoE.` })
    return out
  }
  if (consumers.length === 0) {
    out.push({ id: 'poe-power', label: 'PoE power', verdict: 'info', text: `${supply} W of PoE budget and ${byClass(have)} ${sockets === 1 ? 'port' : 'ports'}, and no PoE-powered device in the plan yet.` })
    return out
  }

  // Power. Known demand already over the known supply is bad whatever the unknowns are.
  if (demand > supply && noBudget.length === 0) out.push({ id: 'poe-power', label: 'PoE power', verdict: 'bad', text: `Devices can draw up to ${demand} W, over the ${supply} W the plan supplies.` })
  else if (noDraw.length > 0 || noBudget.length > 0) {
    const why = [noDraw.length > 0 && `no power draw is known for ${list(noDraw)}`, noBudget.length > 0 && `no PoE budget is known for ${list(noBudget)}`].filter(Boolean).join('; ')
    out.push({ id: 'poe-power', label: 'PoE power', verdict: 'unknown', text: `Can't tell: ${why}. Known so far: ${demand} W drawn, ${supply} W supplied.` })
  } else out.push({ id: 'poe-power', label: 'PoE power', verdict: demand <= supply ? 'ok' : 'bad', text: `Devices draw up to ${demand} W of the ${supply} W supplied.` })

  // Ports: a device needs a port of at least its class.
  const lost = unplaced(need, have)
  out.push({
    id: 'poe-ports',
    label: 'PoE ports',
    verdict: lost === 0 ? 'ok' : 'bad',
    text: `${byClass(need)} ${devices === 1 ? 'device' : 'devices'} for ${byClass(have)} ${sockets === 1 ? 'port' : 'ports'}${lost > 0 ? `: ${lost} can't be given a port of a high enough class` : ''}.`,
  })
  return out
}

function rackCheck(lines: DerivedLine[]): PlanCheck[] {
  const mounted = lines.filter((l) => l.derived?.known.rack && l.derived.rack.mountable)
  if (mounted.length === 0) return []
  const unitsOf = (l: DerivedLine) => l.derived!.rack.units
  const unsure = mounted.filter((l) => unitsOf(l) <= 0)
  const total = mounted.reduce((n, l) => n + l.view.line.qty * Math.max(0, unitsOf(l)), 0)
  const parts = mounted.filter((l) => unitsOf(l) > 0).map((l) => `${l.view.line.qty > 1 ? `${l.view.line.qty} × ` : ''}${name(l)} ${unitsOf(l)}U`)
  const base = `${total}U of rack space${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`
  return [
    unsure.length > 0
      ? { id: 'rack', label: 'Rack space', verdict: 'unknown', text: `Can't tell: the height of ${list(unsure)} isn't known. ${base} so far.` }
      : { id: 'rack', label: 'Rack space', verdict: 'info', text: base + '.' },
  ]
}

/**
 * What the plan adds up to, from the products' derived specifications: whether the PoE switches can
 * power the PoE devices, and how much rack they take. A check appears only when the plan has something
 * for it, and says "can't tell" rather than guessing when a number is missing.
 */
export function planChecks(lines: DerivedLine[]): PlanCheck[] {
  return [...poeCheck(lines), ...rackCheck(lines)]
}
