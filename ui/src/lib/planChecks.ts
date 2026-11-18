import type { Derived } from '../api/types'
import type { LineView } from './plan'
import { formatSpeed, POE_CLASSES } from './requirements'

/** What a check found. 'info' is a fact with nothing to judge it against; 'warn' works, but not as well as it could. */
export type CheckVerdict = 'ok' | 'bad' | 'warn' | 'unknown' | 'info'

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

/**
 * How fast a PoE-powered device's network port is: its PoE-in port if the store marks one, else its fastest
 * copper port (the one a PoE cable would plug into). Null when that isn't known.
 */
function deviceSpeed(d: Derived): number | null {
  const inPorts = d.known.ports ? poePortsIn(d) : []
  const candidates = inPorts.length > 0 ? inPorts : d.known.ports ? dataPorts(d).filter((p) => p.media === 'rj45' && p.poe_direction !== 'out') : []
  const best = Math.max(0, ...candidates.map((p) => p.max_speed_mbps))
  return best > 0 ? best : null
}

interface Socket {
  rank: number
  /** Infinity when the store doesn't say, so an unknown speed never causes a warning. */
  speed: number
  /** Which switch (one unit of a line) the port is on; each has its own PoE budget. */
  unit: number
}

interface Device {
  rank: number
  speed: number
  /** Watts; 0 when not known, which the power check reports separately. */
  draw: number
}

interface Placement {
  /** The speed the device ends up at on its port. */
  speed: number
  unit: number
}

/**
 * Gives every device a port on a switch: of a high enough class, on a switch with enough budget left. Two
 * orders are tried and the one that places more devices wins. The first favours speed: devices fastest
 * first, each on the lowest class of port that is fast enough (so faster and higher-class ports stay free for
 * those that need them), with the rest put on the fastest port left. The second is by demand: highest class
 * and heaviest draw first. Where ports are otherwise alike, the switch with the least budget left that still
 * fits the device is used, so large budgets stay whole for heavy loads. Returns null for a device that fits nowhere.
 */
function allocate(devices: Device[], sockets: Socket[], budgets: number[]): (Placement | null)[] {
  const attempt = (speedFirst: boolean): (Placement | null)[] => {
    const free = [...sockets]
    const left = [...budgets]
    const result: (Placement | null)[] = devices.map(() => null)
    const idx = devices.map((_, i) => i)
    const put = (i: number, k: number) => {
      const f = free[k]!
      result[i] = { speed: Math.min(f.speed, devices[i]!.speed), unit: f.unit }
      left[f.unit] = left[f.unit]! - devices[i]!.draw
      free.splice(k, 1)
    }
    const pick = (i: number, ok: (f: Socket) => boolean, better: (f: Socket, g: Socket) => number): number => {
      const d = devices[i]!
      let best = -1
      free.forEach((f, k) => {
        if (f.rank < d.rank || left[f.unit]! < d.draw || !ok(f)) return
        if (best < 0 || better(f, free[best]!) < 0) best = k
      })
      return best
    }
    const demand = (a: number, b: number) => devices[b]!.rank - devices[a]!.rank || devices[b]!.draw - devices[a]!.draw
    let rest = idx.sort(demand)
    if (speedFirst) {
      rest = []
      for (const i of [...idx].sort((a, b) => devices[b]!.speed - devices[a]!.speed || demand(a, b))) {
        const k = pick(i, (f) => f.speed >= devices[i]!.speed, (f, g) => f.rank - g.rank || f.speed - g.speed || left[f.unit]! - left[g.unit]!)
        if (k < 0) rest.push(i)
        else put(i, k)
      }
      rest.sort(demand)
    }
    for (const i of rest) {
      const k = pick(i, () => true, (f, g) => g.speed - f.speed || f.rank - g.rank || left[f.unit]! - left[g.unit]!)
      if (k >= 0) put(i, k)
    }
    return result
  }
  const first = attempt(true)
  if (!first.includes(null)) return first
  const second = attempt(false)
  return second.filter((x) => x === null).length < first.filter((x) => x === null).length ? second : first
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

/** Warns when a device has a faster network port than the PoE port it was given, so it can't run at full speed. */
function speedCheck(devices: { line: DerivedLine; speed: number }[], placed: (Placement | null)[]): PlanCheck[] {
  const slow = new Map<DerivedLine, { n: number; of: number; speed: number; at: number }>()
  devices.forEach((d, i) => {
    const at = placed[i]?.speed
    const row = slow.get(d.line) ?? { n: 0, of: d.line.view.line.qty, speed: d.speed, at: Infinity }
    if (at !== undefined && at < d.speed) {
      row.n++
      row.at = Math.min(row.at, at)
    }
    slow.set(d.line, row)
  })
  const limited = [...slow].filter(([, r]) => r.n > 0)
  if (limited.length === 0) return []
  const parts = limited.map(([l, r]) => `${r.n === r.of ? (r.of === 1 ? '' : 'all ') : `${r.n} of `}${r.of === 1 ? '' : `${r.of} `}${name(l)} (${formatSpeed(r.speed)} port) would run at ${r.at === Infinity ? 'a lower speed' : `${formatSpeed(r.at)}`}`)
  return [{ id: 'poe-speed', label: 'Port speed', verdict: 'warn', text: `The PoE ports on offer aren't fast enough for every device: ${parts.join('; ')}.` }]
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
  if (lost > 0) return out

  // Which device goes on which switch: each switch has a budget of its own, so the total isn't enough.
  const placing: { line: DerivedLine; rank: number; speed: number; draw: number }[] = []
  for (const l of consumers) for (let i = 0; i < qty(l); i++) placing.push({ line: l, rank: rank(needs.get(l)!), speed: (l.derived && deviceSpeed(l.derived)) ?? 0, draw: metric(l.derived, 'power_draw_max_w') ?? 0 })
  const units: { line: DerivedLine; n: number }[] = suppliers.flatMap((l) => Array.from({ length: qty(l) }, (_, n) => ({ line: l, n })))
  const budgets = units.map((u) => metric(u.line.derived, 'poe_budget_w') ?? Infinity)
  const socketList: Socket[] = units.flatMap((u, unit) => poePortsOut(u.line.derived!).flatMap((p) => Array.from({ length: p.count }, () => ({ rank: rank(p.poe_class), speed: p.max_speed_mbps > 0 ? p.max_speed_mbps : Infinity, unit }))))
  const placed = allocate(placing, socketList, budgets)
  const stranded = placing.filter((_, i) => placed[i] === null)
  if (stranded.length > 0 && demand <= supply) {
    const names = [...new Set(stranded.map((d) => name(d.line)))].join(', ')
    const at = out.findIndex((c) => c.id === 'poe-power')
    const bad: PlanCheck = { id: 'poe-power', label: 'PoE power', verdict: 'bad', text: `The ${supply} W adds up, but each switch has its own budget, and no way of dividing the devices among them powers all: ${stranded.length} of ${names} ${stranded.length === 1 ? 'is' : 'are'} left without.` }
    if (out[at]?.verdict === 'ok') out[at] = bad
    return out
  }
  if (units.length > 1 && stranded.length === 0) {
    const label = (u: { line: DerivedLine; n: number }) => `${name(u.line)}${qty(u.line) > 1 ? ` #${u.n + 1}` : ''}`
    const parts = units.flatMap((u, k) => {
      const mine = placing.filter((_, i) => placed[i]?.unit === k)
      if (mine.length === 0) return []
      const counts = new Map<string, number>()
      for (const d of mine) counts.set(name(d.line), (counts.get(name(d.line)) ?? 0) + 1)
      const used = mine.reduce((n, d) => n + d.draw, 0)
      return [`${label(u)}: ${[...counts].map(([nm, c]) => `${c} × ${nm}`).join(', ')} (${used} of ${budgets[k] === Infinity ? '?' : budgets[k]} W)`]
    })
    out.push({ id: 'poe-layout', label: 'PoE layout', verdict: 'info', text: `One way to divide them: ${parts.join('; ')}.` })
  }
  out.push(...speedCheck(placing, placed))
  return out
}

/** The product types that could go in a rack, so a desktop one is worth a mention. An access point or camera never would. */
const RACKABLE_TYPES = new Set(['Switches', 'Gateways', 'Storage'])

function rackCheck(lines: DerivedLine[]): PlanCheck[] {
  const rackable = (l: DerivedLine) => RACKABLE_TYPES.has(l.view.product?.type ?? '')
  const mounted = lines.filter((l) => l.derived?.known.rack && l.derived.rack.mountable)
  // Equipment that sits on a shelf or desk, and equipment whose mounting isn't known (not the same thing).
  const desktop = lines.filter((l) => rackable(l) && l.derived?.known.rack && !l.derived.rack.mountable)
  const unsureMounting = lines.filter((l) => rackable(l) && !l.derived?.known.rack)
  if (mounted.length === 0 && desktop.length === 0 && unsureMounting.length === 0) return []

  const unitsOf = (l: DerivedLine) => l.derived!.rack.units
  const unsureHeight = mounted.filter((l) => unitsOf(l) <= 0)
  const total = mounted.reduce((n, l) => n + l.view.line.qty * Math.max(0, unitsOf(l)), 0)
  const parts = mounted.filter((l) => unitsOf(l) > 0).map((l) => `${l.view.line.qty > 1 ? `${l.view.line.qty} × ` : ''}${name(l)} ${unitsOf(l)}U`)
  const base = mounted.length > 0 ? `${total}U of rack space${parts.length > 0 ? ` (${parts.join(', ')})` : ''}` : 'Nothing in the plan goes in a rack'
  const unsure = unsureHeight.length > 0 || unsureMounting.length > 0
  const sentences = [
    unsureHeight.length > 0 ? `Can't tell: the height of ${list(unsureHeight)} isn't known. ${base} so far.` : `${base}.`,
    desktop.length > 0 && `Not rack-mount, so it needs a shelf or desk space: ${list(desktop)}.`,
    unsureMounting.length > 0 && `Can't tell whether ${list(unsureMounting)} ${unsureMounting.length === 1 ? 'is' : 'are'} rack-mount.`,
  ].filter(Boolean)
  return [{ id: 'rack', label: 'Rack space', verdict: unsure ? 'unknown' : 'info', text: sentences.join(' ') }]
}

/**
 * What the plan adds up to, from the products' derived specifications: whether the PoE switches can
 * power the PoE devices, and how much rack they take. A check appears only when the plan has something
 * for it, and says "can't tell" rather than guessing when a number is missing.
 */
export function planChecks(lines: DerivedLine[]): PlanCheck[] {
  return [...poeCheck(lines), ...rackCheck(lines)]
}
