import type { Derived } from '../api/types'
import type { LineView } from './plan'
import { netPortCheck, type NetStats } from './netPorts'
import { nvrCheck, type NvrStats } from './nvrChecks'
import { panelUnits, RACK_MOUNTS, RACK_PANELS, RACK_UNITS, NEEDS_RACK_MOUNT } from './rackMounts'
import { budgetOf, powerOptions, type Powering } from './powering'
import { roleCheck, type Hosting, type Role } from './roles'
import { formatSpeed, POE_CLASSES } from './requirements'

/** What a check found. 'info' is a fact with nothing to judge it against; 'warn' works, but not as well as it could. */
export type CheckVerdict = 'ok' | 'bad' | 'warn' | 'unknown' | 'info'

/** A line of a breakdown: plain, or with a list under it. */
export type DetailRow = string | { text: string; items: string[] }

export interface PlanCheck {
  id: string
  label: string
  verdict: CheckVerdict
  text: string
  /** The same, laid out as a list of points, each with a list under it (`text` is those run together). */
  groups?: { text: string; ordered?: boolean; items?: string[] }[]
  /** A breakdown to show on request, as blocks of lines (one block per switch, say). */
  detail?: { title: string; rows: DetailRow[] }[]
  /** True when the plan doesn't have the PoE power or ports its devices need, which more switch could fix. */
  shortfall?: boolean
  /** True when there are cameras and no NVR with room for them, which an NVR could fix. */
  nvrShortfall?: boolean
  /** On a role check: the role (a gateway, a Network controller...) nothing in the plan that can be had fills, which a product could fix. */
  roleShortfall?: Role
  /** On a role check: the controller the owner has chosen to run elsewhere (cloud hosting, or self-hosted), which can be undone. */
  hosted?: Role
  /** On the NVR check: how the cameras came out. */
  nvr?: NvrStats
  /** On the switch-port check: how the devices that aren't PoE-powered came out. */
  net?: NetStats
  /** On the layout check: how the placement came out, for comparing switches. */
  stats?: PoeStats
}

export interface PoeStats {
  /** PoE-powered devices in the plan; the PoE figures mean nothing when there are none. */
  devices: number
  /** Devices with no port and budget to go on. */
  stranded: number
  /** Devices on a port slower than their own. */
  slowed: number
  /** Of those, the ones left below 1 GbE (or below their own speed, for a device slower than that). */
  crawling: number
  /** The slowest speed any device ends up at, and the speed that device could do; null when none is slowed. */
  slowestMbps: number | null
  slowedFromMbps: number | null
  /** Watts of budget left over; null when a switch's budget isn't known. */
  spareWatts: number | null
  /** PoE ports with nothing on them. */
  sparePorts: number
  /** Switch ports of any kind left after every device has one; null when no device that isn't PoE-powered needs a port. */
  netSpare: number | null
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

/**
 * The PoE class a line needs to be powered, or null when it isn't a PoE-powered device. A switch that can be
 * powered several ways is PoE-powered only when it has been chosen to run on a PoE input, and then needs that class.
 */
function needOf(l: DerivedLine, powering: Powering): string | null {
  if (!l.derived) return null
  if (powerOptions(l.derived)) return budgetOf(l, powering).option?.poeClass ?? null
  return poeNeed(l.derived)
}

/** True when a product is a PoE-powered device. */
export const isPoePowered = (l: DerivedLine, powering: Powering = {}): boolean => needOf(l, powering) !== null

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
  /** Index of the port group (a count of alike ports on one switch) the port belongs to. */
  group: number
}

interface Device {
  rank: number
  speed: number
  /** Watts; 0 when not known, which the power check reports separately. */
  draw: number
  /** Switches (by unit) whose ports it can't take: a switch can't be powered by itself. */
  exclude?: ReadonlySet<number>
}

interface Placement {
  /** The speed the device ends up at on its port. */
  speed: number
  unit: number
  group: number
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
      result[i] = { speed: Math.min(f.speed, devices[i]!.speed), unit: f.unit, group: f.group }
      left[f.unit] = left[f.unit]! - devices[i]!.draw
      free.splice(k, 1)
    }
    const pick = (i: number, ok: (f: Socket) => boolean, better: (f: Socket, g: Socket) => number): number => {
      const d = devices[i]!
      let best = -1
      free.forEach((f, k) => {
        if (f.rank < d.rank || left[f.unit]! < d.draw || !ok(f) || d.exclude?.has(f.unit)) return
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
  return [{ id: 'poe-speed', label: 'Port speed', verdict: 'warn', shortfall: true, text: `The PoE ports on offer aren't fast enough for every device: ${parts.join('; ')}.` }]
}

function poeCheck(lines: DerivedLine[], powering: Powering): PlanCheck[] {
  const budget = (l: DerivedLine) => budgetOf(l, powering)
  const needs = new Map(lines.map((l) => [l, needOf(l, powering)] as const))
  const consumers = lines.filter((l) => needs.get(l) !== null && needs.get(l) !== undefined)
  const suppliers = lines.filter((l) => l.derived?.known.ports && poePortsOut(l.derived!).length > 0)
  if (consumers.length === 0 && suppliers.length === 0) return []
  const qty = (l: DerivedLine) => l.view.line.qty

  // A switch on a PoE input draws what it uses itself, and what it passes on, which is the devices on it.
  const poweredSwitches = new Set(consumers.filter((l) => powerOptions(l.derived) !== null))
  const drawOf = (l: DerivedLine): number | null => (poweredSwitches.has(l) ? (metric(l.derived, 'power_draw_excl_poe_w') ?? 0) : metric(l.derived, 'power_draw_max_w'))
  const noDraw = consumers.filter((l) => drawOf(l) === null)
  const noBudget = suppliers.filter((l) => budget(l).watts === null)
  const unchosen = noBudget.filter((l) => budget(l).choose)
  const demand = consumers.reduce((n, l) => n + qty(l) * (drawOf(l) ?? 0), 0)
  const supply = suppliers.reduce((n, l) => n + qty(l) * (budget(l).watts ?? 0), 0)
  const devices = consumers.reduce((n, l) => n + qty(l), 0)
  const need = new Map<string, number>()
  for (const l of consumers) need.set(needs.get(l)!, (need.get(needs.get(l)!) ?? 0) + qty(l))
  const have = new Map<string, number>()
  for (const l of suppliers) for (const p of poePortsOut(l.derived!)) have.set(p.poe_class, (have.get(p.poe_class) ?? 0) + qty(l) * p.count)
  const sockets = [...have.values()].reduce((a, b) => a + b, 0)
  const out: PlanCheck[] = []

  if (suppliers.length === 0) {
    out.push({ id: 'poe-power', label: 'PoE power', verdict: 'info', shortfall: true, text: `${devices} PoE-powered ${devices === 1 ? 'device needs' : 'devices need'} up to ${demand} W (${byClass(need)}); nothing in the plan supplies PoE.` })
    return out
  }
  if (consumers.length === 0) {
    out.push({ id: 'poe-power', label: 'PoE power', verdict: 'info', text: `${supply} W of PoE budget and ${byClass(have)} ${sockets === 1 ? 'port' : 'ports'}, and no PoE-powered device in the plan yet.` })
    return out
  }

  // Switches that can't be bought now don't really supply anything.
  const unavailable = suppliers.filter((l) => l.view.state !== 'in')
  if (consumers.length > 0 && unavailable.length > 0) {
    out.push({ id: 'poe-stock', label: 'PoE switches', verdict: 'warn', shortfall: true, text: `${list(unavailable)} ${unavailable.length === 1 && qty(unavailable[0]!) === 1 ? "isn't" : "aren't"} in stock, so the PoE power and ports it gives can't be had now.` })
  }

  // Power. Known demand already over the known supply is bad whatever the unknowns are.
  if (demand > supply && noBudget.length === 0) out.push({ id: 'poe-power', label: 'PoE power', verdict: 'bad', shortfall: true, text: `Devices can draw up to ${demand} W, over the ${supply} W the plan supplies.` })
  else if (noDraw.length > 0 || noBudget.length > 0) {
    const why = [noDraw.length > 0 && `no power draw is known for ${list(noDraw)}`, noBudget.length > unchosen.length && `no PoE budget is known for ${list(noBudget.filter((l) => !unchosen.includes(l)))}`, unchosen.length > 0 && `how ${list(unchosen)} ${unchosen.length === 1 && qty(unchosen[0]!) === 1 ? 'is' : 'are'} powered hasn't been chosen, and the PoE it passes on depends on that`].filter(Boolean).join('; ')
    out.push({ id: 'poe-power', label: 'PoE power', verdict: 'unknown', text: `Can't tell: ${why}. Known so far: ${demand} W drawn, ${supply} W supplied.` })
  } else out.push({ id: 'poe-power', label: 'PoE power', verdict: demand <= supply ? 'ok' : 'bad', shortfall: demand > supply, text: `Devices draw up to ${demand} W of the ${supply} W supplied.` })

  // Ports: a device needs a port of at least its class.
  const lost = unplaced(need, have)
  out.push({
    id: 'poe-ports',
    label: 'PoE ports',
    verdict: lost === 0 ? 'ok' : 'bad',
    shortfall: lost > 0,
    text: `${byClass(need)} ${devices === 1 ? 'device' : 'devices'} for ${byClass(have)} ${sockets === 1 ? 'port' : 'ports'}${lost > 0 ? `: ${lost} can't be given a port of a high enough class` : ''}.`,
  })
  if (lost > 0) return out

  // Which device goes on which switch: each switch has a budget of its own, so the total isn't enough.
  const placing: { line: DerivedLine; rank: number; speed: number; draw: number; exclude?: ReadonlySet<number> }[] = []
  for (const l of consumers) for (let i = 0; i < qty(l); i++) placing.push({ line: l, rank: rank(needs.get(l)!), speed: (l.derived && deviceSpeed(l.derived)) ?? 0, draw: drawOf(l) ?? 0 })
  const units: { line: DerivedLine; n: number }[] = suppliers.flatMap((l) => Array.from({ length: qty(l) }, (_, n) => ({ line: l, n })))
  const budgets = units.map((u) => budget(u.line).watts ?? Infinity)
  const groups: { unit: number; label: string; count: number }[] = []
  const socketList: Socket[] = units.flatMap((u, unit) =>
    poePortsOut(u.line.derived!).flatMap((p) => {
      const group = groups.push({ unit, label: `${p.max_speed_mbps > 0 ? `${formatSpeed(p.max_speed_mbps)} ` : ''}${p.poe_class}`, count: p.count }) - 1
      return Array.from({ length: p.count }, () => ({ rank: rank(p.poe_class), speed: p.max_speed_mbps > 0 ? p.max_speed_mbps : Infinity, unit, group }))
    }),
  )
  placing.forEach((d) => {
    if (poweredSwitches.has(d.line)) d.exclude = new Set(units.flatMap((u, k) => (u.line === d.line ? [k] : [])))
  })
  let placed = allocate(placing, socketList, budgets)
  // A switch on a PoE input draws the load of the devices placed on it, which depends on where it goes: settle it in a few rounds.
  if (poweredSwitches.size > 0) {
    const own = placing.map((d) => d.draw)
    for (let round = 0; round < 4; round++) {
      const load = new Map<DerivedLine, number>()
      placing.forEach((d, i) => {
        const at = placed[i]
        if (at) load.set(units[at.unit]!.line, (load.get(units[at.unit]!.line) ?? 0) + d.draw)
      })
      let changed = false
      placing.forEach((d, i) => {
        if (!poweredSwitches.has(d.line)) return
        const next = own[i]! + (load.get(d.line) ?? 0) / qty(d.line)
        if (Math.abs(next - d.draw) > 1e-9) changed = true
        d.draw = next
      })
      if (!changed) break
      placed = allocate(placing, socketList, budgets)
    }
    // Two switches can't power each other: where the chain of who powers whom comes back round, none of them is.
    const hostOf = (line: DerivedLine): DerivedLine | null => {
      const i = placing.findIndex((d, k) => d.line === line && placed[k] !== null)
      return i < 0 ? null : units[placed[i]!.unit]!.line
    }
    placing.forEach((d, i) => {
      if (!poweredSwitches.has(d.line) || !placed[i]) return
      let at: DerivedLine | null = hostOf(d.line)
      for (let hops = 0; at && hops < 20; hops++) {
        if (at === d.line) {
          placed[i] = null
          return
        }
        at = hostOf(at)
      }
    })
  }
  const stranded = placing.filter((_, i) => placed[i] === null)

  // Each device on a port group, spelled out: one valid arrangement, not the only one.
  const label = (u: { line: DerivedLine; n: number }) => `${name(u.line)}${qty(u.line) > 1 ? ` #${u.n + 1}` : ''}`
  const detail: NonNullable<PlanCheck['detail']> = units.map((u, k) => {
    const used = placing.reduce((n, d, i) => n + (placed[i]?.unit === k ? d.draw : 0), 0)
    const rows = groups.flatMap((g, gi) => {
      if (g.unit !== k) return []
      const on = new Map<string, number>()
      let taken = 0
      placing.forEach((d, i) => {
        const at = placed[i]
        if (at?.group !== gi) return
        taken++
        const key = `${name(d.line)}${at.speed < d.speed ? ` (runs at ${formatSpeed(at.speed)})` : ''}`
        on.set(key, (on.get(key) ?? 0) + 1)
      })
      const what = [...on].map(([nm, c]) => `${c} × ${nm}`)
      if (taken < g.count) what.push(`${g.count - taken} spare`)
      return [{ text: `${g.count} × ${g.label} ports:`, items: what }]
    })
    return { title: `${label(u)}: ${used} of ${budgets[k] === Infinity ? '?' : budgets[k]} W`, rows }
  })
  if (stranded.length > 0) {
    const counts = new Map<string, number>()
    for (const d of stranded) counts.set(name(d.line), (counts.get(name(d.line)) ?? 0) + 1)
    detail.push({ title: 'No port or power left for', rows: [...counts].map(([nm, c]) => `${c} × ${nm}`) })
  }
  const finite = budgets.every((b) => b !== Infinity)
  const slowedDevices = placing.map((d, i) => ({ d, i })).filter(({ d, i }) => placed[i] !== null && placed[i]!.speed < d.speed)
  const slowest = slowedDevices.reduce<(typeof slowedDevices)[number] | undefined>((a, b) => (a === undefined || placed[b.i]!.speed < placed[a.i]!.speed ? b : a), undefined)
  const stats: PoeStats = {
    stranded: stranded.length,
    slowed: slowedDevices.length,
    crawling: placing.filter((d, i) => placed[i] !== null && placed[i]!.speed < Math.min(1000, d.speed)).length,
    slowestMbps: slowest ? placed[slowest.i]!.speed : null,
    slowedFromMbps: slowest ? slowest.d.speed : null,
    spareWatts: finite ? budgets.reduce((n, b) => n + b, 0) - placing.reduce((n, d, i) => n + (placed[i] ? d.draw : 0), 0) : null,
    sparePorts: socketList.length - placing.filter((_, i) => placed[i] !== null).length,
    devices: placing.length,
    netSpare: null,
  }
  const layout: PlanCheck = { id: 'poe-layout', label: 'PoE layout', verdict: 'info', text: `One way to put each device on a port${units.length > 1 ? `, across ${units.length} switches` : ''}.`, detail, stats }

  if (stranded.length > 0 && demand <= supply) {
    const names = [...new Set(stranded.map((d) => name(d.line)))].join(', ')
    const at = out.findIndex((c) => c.id === 'poe-power')
    const bad: PlanCheck = { id: 'poe-power', label: 'PoE power', verdict: 'bad', shortfall: true, text: `The ${supply} W adds up, but each switch has its own budget, and no way of dividing the devices among them powers all: ${stranded.length} of ${names} ${stranded.length === 1 ? 'is' : 'are'} left without.` }
    if (out[at]?.verdict === 'ok') out[at] = bad
    out.push(layout)
    return out
  }
  out.push(layout)
  out.push(...speedCheck(placing, placed))
  return out
}

/** The product types that could go in a rack, so a desktop one is worth a mention. An access point or camera never would. */
const RACKABLE_TYPES = new Set(['Switches', 'Gateways', 'Storage'])
/** Store categories that could too: the recorders and consoles filed with the cameras (the Instant and the CloudKey+ are desktop). */
const RACKABLE_CATEGORIES = new Set(['physical-security-nvr'])

function rackCheck(lines: DerivedLine[]): PlanCheck[] {
  const slugOf = (l: DerivedLine) => l.view.product?.slug ?? ''
  const rackable = (l: DerivedLine) => RACKABLE_TYPES.has(l.view.product?.type ?? '') || RACKABLE_CATEGORIES.has(l.view.product?.category ?? '') || NEEDS_RACK_MOUNT.has(slugOf(l))

  // Rack-mount accessories take rack space themselves, and hold the devices that fit them: those are no longer loose.
  const mounts = lines.filter((l) => RACK_MOUNTS[slugOf(l)])
  const room = mounts.map((l) => ({ mount: RACK_MOUNTS[slugOf(l)]!, left: RACK_MOUNTS[slugOf(l)]!.capacity * l.view.line.qty }))
  const loose = new Map<DerivedLine, number>() // how many of a device that needs a mount have none
  for (const l of lines.filter((x) => NEEDS_RACK_MOUNT.has(slugOf(x)))) {
    let need = l.view.line.qty
    for (const r of room) {
      const take = r.mount.fits.includes(slugOf(l)) ? Math.min(need, r.left) : 0
      r.left -= take
      need -= take
    }
    loose.set(l, need)
  }

  // Rack equipment the store doesn't describe as such (a PDU, a patch panel), of a height known here.
  const statedUnits = (l: DerivedLine) => RACK_UNITS[slugOf(l)] ?? (RACK_PANELS.has(slugOf(l)) ? panelUnits(l.view.line.sku) : null) ?? undefined
  const stated = lines.filter((l) => statedUnits(l) !== undefined)
  const mounted = lines.filter((l) => l.derived?.known.rack && l.derived.rack.mountable && !NEEDS_RACK_MOUNT.has(slugOf(l)))
  // Equipment that sits on a shelf or desk, and equipment whose mounting isn't known (not the same thing).
  const desktop = lines.filter((l) => (rackable(l) && l.derived?.known.rack && !l.derived.rack.mountable && !NEEDS_RACK_MOUNT.has(slugOf(l))) || (loose.get(l) ?? 0) > 0)
  const unsureMounting = lines.filter((l) => rackable(l) && !l.derived?.known.rack && !NEEDS_RACK_MOUNT.has(slugOf(l)))
  if (mounted.length === 0 && stated.length === 0 && mounts.length === 0 && desktop.length === 0 && unsureMounting.length === 0) return []

  const unitsOf = (l: DerivedLine) => l.derived!.rack.units
  const unsureHeight = mounted.filter((l) => unitsOf(l) <= 0)
  const sized = [...mounted.filter((l) => unitsOf(l) > 0).map((l) => ({ l, u: unitsOf(l) })), ...stated.map((l) => ({ l, u: statedUnits(l)! })), ...mounts.map((l) => ({ l, u: RACK_MOUNTS[slugOf(l)]!.units }))]
  const total = sized.reduce((n, x) => n + x.l.view.line.qty * x.u, 0)
  // A panel is named with its variant, since the product alone doesn't say which one ("Brush Panel", the 1U being said after).
  const rackName = (l: DerivedLine) => {
    if (!RACK_PANELS.has(slugOf(l))) return name(l)
    const kind = (l.view.variant?.title || l.view.line.sku).replace(/^\d+U\s+/i, '')
    return `${name(l)} (${kind})`
  }
  // One line for each rack unit, so the numbers run with the rack: a 2U device is listed twice.
  const units = sized.flatMap((x) => Array.from({ length: x.l.view.line.qty * x.u }, () => `${rackName(x.l)} ${x.u}U`))
  const parts = sized.map((x) => `${x.l.view.line.qty > 1 ? `${x.l.view.line.qty} × ` : ''}${rackName(x.l)} ${x.u}U`)
  const heading = sized.length > 0 || unsureHeight.length > 0 ? `${total}U of rack space` : 'Nothing in the plan goes in a rack'
  const unsure = unsureHeight.length > 0 || unsureMounting.length > 0
  // A device that needs a mount may be only partly covered by the ones in the plan.
  const shelf = desktop.map((l) => ((loose.get(l) ?? 0) > 0 && (loose.get(l) ?? 0) < l.view.line.qty ? `${name(l)} (${loose.get(l)} of ${l.view.line.qty})` : name(l)))
  const groups: NonNullable<PlanCheck['groups']> = [
    ...(unsureHeight.length > 0 ? [{ text: `Can't tell: the height of ${list(unsureHeight)} isn't known. ${heading} so far.` }] : []),
    { text: unsureHeight.length > 0 ? 'Counted so far' : heading, ordered: true, items: units },
    ...(desktop.length > 0 ? [{ text: 'Not rack-mount, so it needs a shelf or desk space:', items: shelf }] : []),
    ...(unsureMounting.length > 0 ? [{ text: `Can't tell whether ${list(unsureMounting)} ${unsureMounting.length === 1 ? 'is' : 'are'} rack-mount.` }] : []),
  ]
  const flat = [
    unsureHeight.length > 0 ? `Can't tell: the height of ${list(unsureHeight)} isn't known. ${heading}${parts.length > 0 ? ` (${parts.join(', ')})` : ''} so far.` : `${heading}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}.`,
    desktop.length > 0 && `Not rack-mount, so it needs a shelf or desk space: ${shelf.join(', ')}.`,
    unsureMounting.length > 0 && `Can't tell whether ${list(unsureMounting)} ${unsureMounting.length === 1 ? 'is' : 'are'} rack-mount.`,
  ].filter(Boolean)
  return [{ id: 'rack', label: 'Rack space', verdict: unsure ? 'unknown' : 'info', text: flat.join(' '), groups }]
}

/** A switch set to run on an adapter the store sells separately needs one for each, in the plan. */
function powerInputCheck(lines: DerivedLine[], powering: Powering): PlanCheck[] {
  const have = (slug: string) => lines.filter((l) => l.view.product?.slug === slug).reduce((n, l) => n + l.view.line.qty, 0)
  const short: string[] = []
  const wanted = new Map<string, number>()
  for (const l of lines) {
    const a = budgetOf(l, powering).option?.adapter
    if (a) wanted.set(a.slug, (wanted.get(a.slug) ?? 0) + l.view.line.qty)
  }
  for (const l of lines) {
    const a = budgetOf(l, powering).option?.adapter
    if (!a || have(a.slug) >= wanted.get(a.slug)!) continue
    short.push(`${name(l)} runs on the ${a.watts} W AC adapter, which is sold separately: the plan has ${have(a.slug)} of the ${wanted.get(a.slug)} it needs`)
  }
  if (short.length === 0) return []
  return [{ id: 'power-adapter', label: 'Power adapter', verdict: 'warn', text: `${[...new Set(short)].join('; ')}.` }]
}

/**
 * What the plan adds up to, from the products' derived specifications: whether the PoE switches can
 * power the PoE devices, whether every other device has a switch port, and how much rack they take. A check appears only when the plan has something
 * for it, and says "can't tell" rather than guessing when a number is missing.
 */
export function planChecks(lines: DerivedLine[], hosting: Hosting = {}, powering: Powering = {}): PlanCheck[] {
  const poeDevices = lines.reduce((n, l) => n + (isPoePowered(l, powering) ? l.view.line.qty : 0), 0)
  return [...poeCheck(lines, powering), ...powerInputCheck(lines, powering), ...netPortCheck(lines, poeDevices, (l) => isPoePowered(l, powering)), ...nvrCheck(lines), ...roleCheck(lines, hosting), ...rackCheck(lines)]
}

export interface Answer {
  word: string
  emoji: string
  tone: 'ok' | 'warn' | 'bad'
}

/**
 * The one-line answer to "does it add up?": no if anything is wrong, mostly if anything is a warning or can't be told,
 * yes if every check passed. Notes (info) don't count; with nothing but notes there is no answer.
 */
export function overall(checks: PlanCheck[]): Answer | null {
  const vs = checks.map((c) => c.verdict).filter((v) => v !== 'info')
  if (vs.length === 0) return null
  if (vs.includes('bad')) return { word: 'No.', emoji: '❌', tone: 'bad' }
  if (vs.some((v) => v !== 'ok')) return { word: 'Mostly', emoji: '👍', tone: 'warn' }
  return { word: 'Yes!', emoji: '🎉', tone: 'ok' }
}
