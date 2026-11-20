import { lineKey } from './plan'
import { planChecks, type DerivedLine, type Link, type Trace, type UnitRef } from './planChecks'
import type { Hosting } from './roles'
import { isGatewayProduct } from './roles'
import type { Powering } from './powering'

/** A box in the plan drawn as a graph: a gateway, a switch, or devices of one product plugged into the same one. */
export interface TopoNode {
  key: string
  /** The product's name; for a switch or gateway the line's own units are told apart by a number. */
  title: string
  kind: 'gateway' | 'switch' | 'device'
  /** How many identical devices the box stands for. */
  qty: number
  /** How it is plugged in, as "10GbE SFP+"; absent for a gateway, and for what has no port to be on. */
  uplink?: { label: string; /** True when the link runs slower than the device could. */ slow: boolean }
  /** Ports left free on a switch. */
  spare?: number
  /** What is plugged into it: other switches first, then devices. */
  children: TopoNode[]
}

export interface Topology {
  /** The gateways, or the root switch when there is none, each with what hangs from it. */
  roots: TopoNode[]
  /** Devices and switches that no port or power could be found for, which hang from nothing. */
  unconnected: TopoNode[]
}

const name = (l: DerivedLine) => l.view.product?.title ?? l.view.line.ref
const unitKey = (u: UnitRef) => `${lineKey(u.line.view.line)}#${u.n}`
/** A speed as "10GbE", "2.5GbE" or "100Mbps"; empty when the store doesn't say. */
const speedText = (mbps: number) => (!Number.isFinite(mbps) ? '' : mbps >= 1000 ? `${mbps / 1000}GbE` : `${mbps}Mbps`)
const uplinkOf = (l: Link): NonNullable<TopoNode['uplink']> => ({ label: [speedText(l.speed), l.media].filter(Boolean).join(' '), slow: Number.isFinite(l.speed) && Number.isFinite(l.capable) && l.speed < l.capable })
const isSwitch = (l: DerivedLine) => l.view.product?.type === 'Switches'

/**
 * The plan as a tree for drawing: the gateway at the top, the switches under what they uplink to, and the devices under
 * the switch or gateway they were given a port on (or, for PoE devices, a PoE port, which is the switch that powers them).
 * It is one arrangement the checks found, not the only one. Null when the plan has no gateway or switch to hang anything
 * from, or only one box to show.
 */
export function buildTopology(lines: DerivedLine[], hosting: Hosting = {}, powering: Powering = {}): Topology | null {
  const trace: Trace = {}
  planChecks(lines, hosting, powering, trace)
  const units: { ref: UnitRef; kind: 'gateway' | 'switch' }[] = lines.flatMap((l) => {
    const kind = isGatewayProduct(l.view.product, l.derived) ? 'gateway' : isSwitch(l) ? 'switch' : null
    return kind ? Array.from({ length: l.view.line.qty }, (_, n) => ({ ref: { line: l, n }, kind })) : []
  })
  if (units.length === 0) return null
  const qty = (l: DerivedLine) => l.view.line.qty
  const title = (u: UnitRef) => `${name(u.line)}${qty(u.line) > 1 ? ` #${u.n + 1}` : ''}`
  const gateways = units.filter((u) => u.kind === 'gateway')

  const parentOf = new Map<string, UnitRef | null>(trace.uplinks?.map((l) => [unitKey(l.unit), l.parent]))
  const linkOf = new Map(trace.uplinks?.map((l) => [unitKey(l.unit), uplinkOf(l.link)]))
  const spareOf = new Map(trace.spare?.map((s) => [unitKey(s.unit), s.spare]))
  const children = new Map<string, TopoNode[]>()
  const add = (host: UnitRef, node: TopoNode) => children.set(unitKey(host), [...(children.get(unitKey(host)) ?? []), node])

  // Devices on the same switch that are the same product share a box.
  // (Unless they are plugged in differently, which would otherwise be hidden.)
  const groups = new Map<string, { host: UnitRef; line: DerivedLine; n: number; uplink: TopoNode['uplink'] }>()
  for (const h of [...(trace.portHosts ?? []), ...(trace.poeHosts ?? [])]) {
    const uplink = uplinkOf(h.link)
    const key = `${unitKey(h.host)}|${lineKey(h.line.view.line)}|${uplink.label}|${uplink.slow}`
    const g = groups.get(key)
    if (g) g.n++
    else groups.set(key, { host: h.host, line: h.line, n: 1, uplink })
  }
  const devices = [...groups.entries()].sort((a, b) => name(a[1].line).localeCompare(name(b[1].line)))
  for (const [key, g] of devices) add(g.host, { key, title: name(g.line), kind: 'device', qty: g.n, uplink: g.uplink, children: [] })

  const node = (u: { ref: UnitRef; kind: 'gateway' | 'switch' }): TopoNode => ({ key: unitKey(u.ref), title: title(u.ref), kind: u.kind, qty: 1, ...(u.kind === 'switch' ? { uplink: linkOf.get(unitKey(u.ref)), spare: spareOf.get(unitKey(u.ref)) } : {}), children: [] })
  const nodes = new Map(units.map((u) => [unitKey(u.ref), node(u)] as const))
  const roots: TopoNode[] = gateways.map((g) => nodes.get(unitKey(g.ref))!)
  const unconnected: TopoNode[] = []
  for (const u of units.filter((u) => u.kind === 'switch')) {
    const n = nodes.get(unitKey(u.ref))!
    const key = unitKey(u.ref)
    if (!parentOf.has(key)) unconnected.push(n) // no uplink was found for it
    else if (parentOf.get(key) === null) roots.push(n) // it uplinks outside the plan
    else add(parentOf.get(key)!, n)
  }
  // A switch before a device under each unit, as the lists were built devices first.
  for (const [k, kids] of children) {
    const n = nodes.get(k)
    if (n) n.children = [...kids.filter((c) => c.kind === 'switch'), ...kids.filter((c) => c.kind !== 'switch')]
  }

  const lost = new Map<string, TopoNode>()
  for (const l of [...(trace.portLost ?? []), ...(trace.poeLost ?? [])]) {
    const k = lineKey(l.view.line)
    const prev = lost.get(k)
    if (prev) prev.qty++
    else lost.set(k, { key: `lost:${k}`, title: name(l), kind: 'device', qty: 1, children: [] })
  }
  unconnected.push(...lost.values())

  const count = (n: TopoNode): number => 1 + n.children.reduce((a, c) => a + count(c), 0)
  if (roots.length === 0 || roots.reduce((a, r) => a + count(r), 0) < 2) return null
  return { roots, unconnected }
}
