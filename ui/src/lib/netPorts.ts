import type { Port } from '../api/types'
import type { DerivedLine, PlanCheck, Trace } from './planChecks'
import { formatSpeed } from './requirements'
import { isGatewayProduct } from './roles'

export interface NetStats {
  /** Devices and switch uplinks that got no port. */
  unplaced: number
  /** Ports left over once everything that needs one has one (PoE-powered devices included). */
  spare: number
  /** Switches with SFP-style cages that, for want of a free cage upstream, are uplinked over copper (or through a module). */
  sfpMisses: number
}

/** Which kind of device plugs in where: copper, an SFP-style cage (SFP, SFP+, SFP28), or a combo position that takes either. */
type Media = 'rj45' | 'sfp' | 'either'

/** A run of alike ports on one switch or gateway. */
interface Group {
  unit: Unit
  media: Media
  /** Infinity when the store doesn't say, so an unknown speed never causes a complaint. */
  speed: number
  free: number
  /** Whether the ports can power a device (they are also what PoE-powered devices take). */
  poe: boolean
  /** A port that takes PoE in: a switch's own way of being uplinked, no use to anything below it. */
  uplinkOnly: boolean
  label: string
  /** The kind of cage (SFP, SFP+, SFP28) when there is one, as the store names it. */
  cage: string
}

/** One switch or gateway (one unit of a line). */
interface Unit {
  line: DerivedLine
  n: number
  kind: 'switch' | 'gateway'
  groups: Group[]
  /** SFP-style cages the unit has to begin with (a combo position counts). */
  cages: number
  /** How many hops from the gateway: 1 for the root switch. */
  depth: number
}

/** A device that needs a port: which kinds of port it has and how fast each is (null when it has none of that kind). */
interface Device {
  line: DerivedLine
  rj45: number | null
  sfp: number | null
}

const isSfp = (m: string) => m.startsWith('sfp') // QSFP is left out: nothing here assumes an adapter
const isNetwork = (p: Port) => p.role === 'data' && (p.media === 'rj45' || isSfp(p.media))
const speedOf = (p: Port) => (p.max_speed_mbps > 0 ? p.max_speed_mbps : Infinity)
/** An unknown speed ranks below every known one when ports are compared. */
const rankSpeed = (s: number) => (s === Infinity ? 1 : s)
const name = (l: DerivedLine) => l.view.product?.title ?? l.view.line.ref
const unitName = (u: Unit) => `${name(u.line)}${u.line.view.line.qty > 1 ? ` #${u.n + 1}` : ''}`
const portsLabel = (n: number) => `${n} ${n === 1 ? 'port' : 'ports'}`
const mediaLabel = (m: string) => (m === 'rj45' ? 'RJ45' : m.toUpperCase())
const speedLabel = (s: number) => (s === Infinity ? '' : `${formatSpeed(s)} `)
const unique = (xs: string[]) => [...new Set(xs)].join(', ')

/** The product types that are the network itself: switches (which each need an uplink) and gateways (the top, which need none). */
const isSwitch = (l: DerivedLine) => l.view.product?.type === 'Switches'
const isGateway = (l: DerivedLine) => isGatewayProduct(l.view.product, l.derived)

/** The ports of a switch (or gateway) that something can plug into, grouped, with combo pairs counted once; a switch's PoE-in port is kept apart as its own way of uplinking. */
function groupsOf(unit: Unit): Group[] {
  const ports = (unit.line.derived?.ports ?? []).filter(isNetwork)
  const mk = (p: Port, over: Partial<Group> = {}): Group => ({
    unit,
    media: p.media === 'rj45' ? 'rj45' : 'sfp',
    speed: speedOf(p),
    free: p.count,
    poe: p.poe_class !== '' && p.poe_direction === 'out',
    uplinkOnly: false,
    label: `${speedLabel(speedOf(p))}${mediaLabel(p.media)}`,
    cage: isSfp(p.media) ? mediaLabel(p.media) : '',
    ...over,
  })
  const poeIn = ports.filter((p) => p.poe_direction === 'in')
  const open = ports.filter((p) => p.poe_direction !== 'in')
  const groups = open.filter((p) => !p.combo).map((p) => mk(p))
  const combo = open.filter((p) => p.combo)
  // A combo RJ45/SFP+ pair is one position that takes either, so the two halves aren't both counted.
  if (combo.length > 0) {
    const copper = combo.filter((p) => p.media === 'rj45')
    const fiber = combo.filter((p) => p.media !== 'rj45')
    const n = (ps: Port[]) => ps.reduce((a, p) => a + p.count, 0)
    const speed = Math.max(...combo.map(speedOf))
    groups.push({ ...mk(combo[0]!), cage: fiber[0] ? mediaLabel(fiber[0].media) : '', media: copper.length > 0 && fiber.length > 0 ? 'either' : copper.length > 0 ? 'rj45' : 'sfp', speed, free: Math.max(n(copper), n(fiber)), poe: false, label: `${speedLabel(speed)}${[...new Set(combo.map((p) => mediaLabel(p.media)))].join('/')} combo` })
  }
  if (unit.kind === 'switch') groups.push(...poeIn.map((p) => mk(p, { uplinkOnly: true, poe: false, label: `${speedLabel(speedOf(p))}${mediaLabel(p.media)} (PoE in)` })))
  return groups.filter((g) => g.free > 0)
}

/** What a device plugs in with, from its ports that don't give power out; null when it has no network port we know of. */
function deviceOf(l: DerivedLine): Device | null {
  const d = l.derived
  if (!d?.known.ports) return null
  const ports = d.ports.filter((p) => isNetwork(p) && p.poe_direction !== 'out')
  const best = (ps: Port[]) => (ps.length === 0 ? null : Math.max(...ps.map(speedOf)))
  const rj45 = best(ports.filter((p) => p.media === 'rj45'))
  const sfp = best(ports.filter((p) => isSfp(p.media)))
  return rj45 === null && sfp === null ? null : { line: l, rj45, sfp }
}

type LinkKind = 'sfp' | 'copper' | 'module'
const KIND_RANK: Record<LinkKind, number> = { sfp: 0, copper: 1, module: 2 }

/** How two groups of ports connect: cage to cage (SFP, a DAC or fibre), copper to copper, or copper to a cage through a module. */
function linkOf(a: Group, b: Group): { kind: LinkKind; speed: number } | null {
  const speed = Math.min(a.speed, b.speed)
  if (a.media === 'rj45' && b.media === 'rj45') return { kind: 'copper', speed }
  if (a.media === 'rj45' || b.media === 'rj45') return { kind: a.media === 'either' || b.media === 'either' ? 'copper' : 'module', speed }
  return { kind: 'sfp', speed }
}

/** Compares two lists of numbers, the first difference deciding; negative when `a` is better (lower). */
function lex(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return a[i]! - b[i]!
  return 0
}

interface Uplink {
  unit: Unit
  /** The unit it plugs into; null when that is outside the plan (an existing router, say). */
  parent: Unit | null
  kind: LinkKind | 'external'
  speed: number
  group: Group
  parentGroup: Group | null
}

/** The best way for `child` to plug into one of `parents` (or, with none, into the network outside), consuming the ports; null when no port is free. */
function uplink(child: Unit, parents: Unit[] | null): Uplink | null {
  type Cand = { cg: Group; pg: Group | null; kind: LinkKind | 'external'; speed: number }
  const cands: Cand[] = []
  for (const cg of child.groups) {
    if (cg.free <= 0) continue
    if (parents === null) cands.push({ cg, pg: null, kind: 'external', speed: cg.speed })
    else
      for (const p of parents)
        for (const pg of p.groups) {
          if (pg.free <= 0 || pg.uplinkOnly) continue
          const l = linkOf(cg, pg)
          if (l) cands.push({ cg, pg, ...l })
        }
  }
  // Cages before copper before modules; then the fastest; then ports that aren't PoE (those are for devices), a PoE-in port first as it's no use to anything else.
  const key = (c: Cand) => [c.kind === 'external' ? (c.cg.media === 'rj45' ? 1 : 0) : KIND_RANK[c.kind], -rankSpeed(c.speed), (c.cg.poe ? 1 : 0) + (c.pg?.poe ? 1 : 0), c.cg.uplinkOnly ? 0 : 1]
  cands.sort((a, b) => lex(key(a), key(b)))
  const c = cands[0]
  if (!c) return null
  c.cg.free--
  if (c.pg) c.pg.free--
  return { unit: child, parent: c.pg?.unit ?? null, kind: c.kind, speed: c.speed, group: c.cg, parentGroup: c.pg }
}

interface Placed {
  group: Group
  speed: number
  module: boolean
}

/**
 * Whether the plan's network has the ports it needs, and how it would be wired.
 *
 * Every switch needs an uplink, a port on it and a port upstream. The switch with the most SFP-style cages is the
 * root and uplinks to the gateway (or to the network outside the plan, when there is no gateway). Every other
 * switch uplinks to the root where it can, and only when the root is full to another switch, as flat as possible;
 * a gateway's other ports are the last resort. SFP-style cages are preferred for uplinks and for devices that have
 * one, then copper, then a copper port in a cage through a module. Gateways need no port, and the internet connection isn't modelled.
 *
 * Devices that aren't PoE-powered then take the ports that are left, a spare PoE port included (PoE-powered
 * devices already take PoE ports: `poeDevices` of them). A copper-only device may use a cage through a module,
 * but only when no copper port is left; one with only an SFP port needs a cage.
 *
 * A second check warns when a switch with SFP cages has been uplinked over copper for want of a free cage upstream.
 */
export function netPortCheck(lines: DerivedLine[], poeDevices: number, poePowered: (l: DerivedLine) => boolean, trace?: Trace): PlanCheck[] {
  const devices: Device[] = lines.flatMap((l) => {
    if (isSwitch(l) || isGateway(l) || poePowered(l)) return []
    const d = deviceOf(l)
    return d ? Array.from({ length: l.view.line.qty }, () => d) : []
  })
  const suppliers = lines.filter((l) => isSwitch(l) || isGateway(l))
  const unsure = suppliers.filter((l) => !l.derived?.known.ports)
  const units: Unit[] = suppliers.flatMap((l) =>
    l.derived?.known.ports
      ? Array.from({ length: l.view.line.qty }, (_, n): Unit => {
          const u: Unit = { line: l, n, kind: isGateway(l) ? 'gateway' : 'switch', groups: [], cages: 0, depth: 0 }
          u.groups = groupsOf(u)
          u.cages = u.groups.filter((g) => g.media !== 'rj45' && !g.uplinkOnly).reduce((a, g) => a + g.free, 0)
          return u
        })
      : [],
  )
  const switches = units.filter((u) => u.kind === 'switch')
  const gateways = units.filter((u) => u.kind === 'gateway')
  if (devices.length === 0 && switches.length === 0) return []

  if (units.length === 0 && unsure.length === 0) {
    return [{ id: 'net-ports', label: 'Switch ports', verdict: 'info', shortfall: true, text: `${devices.length} ${devices.length === 1 ? 'device needs' : 'devices need'} a switch port (${unique(devices.map((d) => name(d.line)))}); nothing in the plan provides switch ports.` }]
  }

  const downstream = (g: Group) => !g.uplinkOnly

  // The wiring: the switch with the most cages is the root; the rest attach to it, then to whatever is nearest, flattest first.
  const links: Uplink[] = []
  const noUplink: Unit[] = []
  const attach = (u: Unit, to: Uplink | null) => {
    if (!to) noUplink.push(u)
    else {
      u.depth = (to.parent && to.parent.kind === 'switch' ? to.parent.depth : 0) + 1
      links.push(to)
    }
  }
  const ranked = [...switches].sort((a, b) => b.cages - a.cages || b.groups.reduce((n, g) => n + g.free, 0) - a.groups.reduce((n, g) => n + g.free, 0))
  const [root, ...rest] = ranked
  if (root) {
    attach(root, uplink(root, gateways.length > 0 ? gateways : null))
    for (const u of rest) {
      let to: Uplink | null = null
      const attached = switches.filter((s) => s.depth > 0 && s !== u)
      for (const d of [...new Set(attached.map((s) => s.depth))].sort((a, b) => a - b)) {
        to = uplink(u, attached.filter((s) => s.depth === d))
        if (to) break
      }
      attach(u, to ?? (gateways.length > 0 ? uplink(u, gateways) : null))
    }
  }

  // PoE-powered devices are on PoE ports, the slowest ones being the likeliest. The uplinks have already taken theirs (from ports
  // that aren't PoE where there are any); if that leaves too few PoE ports, the PoE check, which doesn't know about uplinks, has missed it.
  const poeGroups = units.flatMap((u) => u.groups).filter((x) => x.poe)
  const poeCapacity = poeGroups.reduce((n, g) => n + g.free, 0) + links.filter((l) => l.group.poe).length + links.filter((l) => l.parentGroup?.poe).length
  let poeLeft = poeDevices
  for (const g of [...poeGroups].sort((a, b) => a.speed - b.speed)) {
    const take = Math.min(g.free, poeLeft)
    g.free -= take
    poeLeft -= take
  }
  const poeShort = poeDevices <= poeCapacity ? poeLeft : 0
  const total = units.flatMap((u) => u.groups).reduce((n, g) => n + (g.uplinkOnly ? 0 : g.free), 0)

  // Devices take what is left: a cage for one that has an SFP port, then the fastest port; the gateway's ports last of all.
  const order = devices.map((_, i) => i).sort((a, b) => {
    const kind = (d: Device) => (d.rj45 === null ? 0 : d.sfp === null ? 2 : 1)
    return kind(devices[a]!) - kind(devices[b]!) || Math.max(devices[b]!.rj45 ?? 0, devices[b]!.sfp ?? 0) - Math.max(devices[a]!.rj45 ?? 0, devices[a]!.sfp ?? 0)
  })
  const sockets = units.flatMap((u) => u.groups.filter(downstream))
  const freeOn = (u: Unit) => u.groups.filter(downstream).reduce((n, g) => n + g.free, 0)
  const fit = (dev: Device, g: Group): { speed: number; module: boolean; cage: boolean } | null => {
    if (g.media === 'either') return { speed: Math.min(g.speed, Math.max(dev.rj45 ?? 0, dev.sfp ?? 0)), module: false, cage: dev.sfp !== null }
    if (g.media === 'rj45') return dev.rj45 === null ? null : { speed: Math.min(g.speed, dev.rj45), module: false, cage: false }
    if (dev.sfp !== null) return { speed: Math.min(g.speed, dev.sfp), module: false, cage: true }
    return dev.rj45 === null ? null : { speed: Math.min(g.speed, dev.rj45), module: true, cage: false }
  }
  const placed: (Placed | null)[] = devices.map(() => null)
  for (const i of order) {
    const dev = devices[i]!
    let best: { g: Group; key: number[]; f: NonNullable<ReturnType<typeof fit>> } | null = null
    for (const g of sockets) {
      if (g.free <= 0) continue
      const f = fit(dev, g)
      if (!f) continue
      // A switch's port before a gateway's; no module; a cage for a device with an SFP port; the fastest; the slowest port that gives it (so quicker ones stay free); a plain port over a combo.
      // Ties then go to the switch nearest the root, then to the one with the most ports left, so the result doesn't depend on the order of the plan's lines.
      const key = [g.unit.kind === 'gateway' ? 1 : 0, f.module ? 1 : 0, dev.sfp !== null && !f.cage ? 1 : 0, -rankSpeed(f.speed), rankSpeed(g.speed), g.media === 'either' ? 1 : 0, g.unit.depth, -freeOn(g.unit)]
      if (!best || lex(key, best.key) < 0) best = { g, key, f }
    }
    if (best) {
      best.g.free--
      placed[i] = { group: best.g, speed: best.f.speed, module: best.f.module }
    }
  }

  const lostDevices = devices.filter((_, i) => placed[i] === null)
  if (trace) {
    trace.uplinks = links.map((l) => ({ unit: l.unit, parent: l.parent }))
    trace.portHosts = devices.flatMap((d, i) => (placed[i] ? [{ line: d.line, host: placed[i]!.group.unit }] : []))
    trace.portLost = lostDevices.map((d) => d.line)
  }
  const lost = lostDevices.length + noUplink.length + poeShort
  const demands = devices.length + switches.length + poeShort
  const spare = units.flatMap((u) => u.groups).reduce((n, g) => n + (g.uplinkOnly ? 0 : g.free), 0)
  const modules = placed.filter((p) => p?.module).length + links.filter((l) => l.kind === 'module').length

  // Switches with cages that are uplinked over copper because a cage wasn't free upstream. (No gateway cage to be had is not something a switch can fix.)
  const misses = links.filter((l) => l.unit.cages > 0 && l.kind !== 'sfp' && l.kind !== 'external' && l.parent !== null && (l.parent.kind === 'switch' || l.parent.cages > 0))
  const stats: NetStats = { unplaced: lost, spare, sfpMisses: misses.length }

  const how = (l: Uplink) => `${speedLabel(l.speed)}${l.kind === 'sfp' ? l.group.cage || l.parentGroup?.cage || 'SFP' : l.kind === 'copper' ? 'copper' : 'copper through an SFP module'}`
  const wiring = links.map((l) => `${unitName(l.unit)} → ${l.parent ? unitName(l.parent) : 'the network outside the plan'}${l.unit === root ? ' (root)' : ''}: ${l.kind === 'external' ? `${l.group.label} port` : how(l)}`)
  const detail: NonNullable<PlanCheck['detail']> = []
  if (wiring.length > 0) detail.push({ title: 'Uplinks', rows: wiring })
  for (const u of units) {
    const on = new Map<string, { group: string; what: string; n: number }>()
    devices.forEach((d, i) => {
      const at = placed[i]
      if (!at || at.group.unit !== u) return
      const best = Math.max(d.rj45 ?? 0, d.sfp ?? 0)
      const what = `${name(d.line)}${at.module ? ' (needs an SFP module)' : ''}${at.speed < best ? ` (runs at ${formatSpeed(at.speed)})` : ''}`
      const key = `${at.group.label}|${what}`
      on.set(key, { group: at.group.label, what, n: (on.get(key)?.n ?? 0) + 1 })
    })
    const rows = [...on.values()].map((r) => `${r.group} ports: ${r.n} × ${r.what}`)
    if (rows.length > 0) detail.push({ title: unitName(u), rows })
  }
  if (lost > 0) {
    const counts = new Map<string, number>()
    lostDevices.forEach((d) => counts.set(name(d.line), (counts.get(name(d.line)) ?? 0) + 1))
    noUplink.forEach((u) => counts.set(`${unitName(u)} (uplink)`, 1))
    detail.push({ title: 'No port left for', rows: [...counts].map(([nm, c]) => `${c} × ${nm}`) })
  }
  const withDetail = detail.length > 0 ? { detail } : {}

  const out: PlanCheck[] = []
  const what = [devices.length > 0 && `${devices.length} ${devices.length === 1 ? 'device' : 'devices'} (${unique(devices.map((d) => name(d.line)))})`, switches.length > 0 && `${switches.length} switch ${switches.length === 1 ? 'uplink' : 'uplinks'}`].filter(Boolean).join(' and ')
  if (lost > 0) {
    const missing = [...lostDevices.map((d) => name(d.line)), ...noUplink.map((u) => `${unitName(u)}'s uplink`), ...(poeShort > 0 ? [`${poeShort} PoE-powered ${poeShort === 1 ? 'device' : 'devices'}, whose ports went to uplinks`] : [])]
    const sfpOnly = lostDevices.filter((d) => d.rj45 === null)
    const why = sfpOnly.length > 0 ? `; ${unique(sfpOnly.map((d) => name(d.line)))} ${sfpOnly.length === 1 ? 'needs' : 'need'} an SFP-style port` : ''
    if (unsure.length > 0) {
      out.push({ id: 'net-ports', label: 'Switch ports', verdict: 'unknown', text: `Can't tell: no ports are known for ${unsure.map(name).join(', ')}. Without them, ${lost} of ${demands} ${demands === 1 ? 'port' : 'ports'} needed (${unique(missing)}) can't be had: ${portsLabel(total)} free after the PoE-powered devices.`, net: stats, ...withDetail })
    } else {
      out.push({ id: 'net-ports', label: 'Switch ports', verdict: 'bad', shortfall: true, text: `${lost} of ${demands} ${demands === 1 ? 'port' : 'ports'} needed can't be had (${unique(missing)}): ${portsLabel(total)} free after the PoE-powered devices${why}.`, net: stats, ...withDetail })
    }
  } else {
    const sentences = [`${what} ${demands === 1 ? 'needs' : 'need'} a port; ${portsLabel(spare)} ${spare === 1 ? 'is' : 'are'} spare after the PoE-powered devices.`, modules > 0 && `${modules} ${modules === 1 ? 'link goes' : 'links go'} through an SFP module.`, unsure.length > 0 && `No ports are known for ${unsure.map(name).join(', ')}, so its ports aren't counted.`].filter(Boolean)
    out.push({ id: 'net-ports', label: 'Switch ports', verdict: 'ok', text: sentences.join(' '), net: stats, ...withDetail })
  }

  if (misses.length > 0) {
    const n = unique(misses.map((l) => unitName(l.unit)))
    out.push({
      id: 'net-sfp',
      label: 'SFP uplinks',
      verdict: 'warn',
      shortfall: true,
      net: stats,
      text: `${n} ${misses.length === 1 ? 'has' : 'have'} SFP ports but ${misses.length === 1 ? 'is' : 'are'} uplinked over copper: ${root ? unitName(root) : 'the root switch'}, the switch with the most SFP cages, hasn't enough free. Something with more SFP connections (usually an aggregation switch; one with four SFP+ ports can serve as a small one) would let every uplink run over SFP.`,
    })
  }
  return out
}
