import type { Port } from '../api/types'
import type { DerivedLine, PlanCheck } from './planChecks'
import { formatSpeed } from './requirements'

export interface NetStats {
  /** Devices that got no switch port. */
  unplaced: number
  /** Switch ports left over after every device that needs one has one (PoE-powered devices included). */
  spare: number
}

/** Which kind of device plugs in where: copper, an SFP-style cage (SFP, SFP+, SFP28), or a combo position that takes either. */
type Media = 'rj45' | 'sfp' | 'either'

/** A run of alike ports on one switch. */
interface Group {
  unit: number
  media: Media
  /** Infinity when the store doesn't say, so an unknown speed never causes a complaint. */
  speed: number
  free: number
  /** Whether the ports can power a device (they are also what PoE-powered devices take). */
  poe: boolean
  label: string
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
const name = (l: DerivedLine) => l.view.product?.title ?? l.view.line.ref
const portsLabel = (n: number) => `${n} ${n === 1 ? 'port' : 'ports'}`
const mediaLabel = (m: string) => (m === 'rj45' ? 'RJ45' : m.toUpperCase())
const speedLabel = (s: number) => (s === Infinity ? '' : `${formatSpeed(s)} `)

/** The product types that are the network itself: they give ports, they don't take one (their uplinks are a matter of layout we don't know). */
const isSwitch = (l: DerivedLine) => l.view.product?.type === 'Switches'
const isGateway = (l: DerivedLine) => l.view.product?.type === 'Gateways'

/** The ports of a switch (or gateway) a device can plug into: those that don't take power in, grouped, with combo pairs counted once. */
function groupsOf(l: DerivedLine, unit: number): Group[] {
  const ports = (l.derived?.ports ?? []).filter((p) => isNetwork(p) && p.poe_direction !== 'in')
  const plain = ports.filter((p) => !p.combo)
  const combo = ports.filter((p) => p.combo)
  const groups: Group[] = plain.map((p) => ({
    unit,
    media: p.media === 'rj45' ? 'rj45' : 'sfp',
    speed: speedOf(p),
    free: p.count,
    poe: p.poe_class !== '' && p.poe_direction === 'out',
    label: `${speedLabel(speedOf(p))}${mediaLabel(p.media)}`,
  }))
  // A combo RJ45/SFP+ pair is one position that takes either, so the two halves aren't both counted.
  if (combo.length > 0) {
    const copper = combo.filter((p) => p.media === 'rj45')
    const fiber = combo.filter((p) => p.media !== 'rj45')
    const n = (ps: Port[]) => ps.reduce((a, p) => a + p.count, 0)
    const speed = Math.max(...combo.map(speedOf))
    groups.push({ unit, media: copper.length > 0 && fiber.length > 0 ? 'either' : copper.length > 0 ? 'rj45' : 'sfp', speed, free: Math.max(n(copper), n(fiber)), poe: false, label: `${speedLabel(speed)}${[...new Set(combo.map((p) => mediaLabel(p.media)))].join('/')} combo` })
  }
  // A gateway keeps a port for its internet connection, and the store doesn't say which; the fastest copper one is the likeliest.
  if (isGateway(l)) {
    const wan = groups.filter((g) => g.media === 'rj45').sort((a, b) => b.speed - a.speed)[0]
    if (wan) wan.free--
  }
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

/** The speed a device would run at in a group of ports, and whether it would need an SFP module to plug in; null when it can't plug in there. */
function fit(dev: Device, g: Group): { speed: number; module: boolean } | null {
  if (g.media === 'either') return { speed: Math.min(g.speed, Math.max(dev.rj45 ?? 0, dev.sfp ?? 0)), module: false }
  if (g.media === 'rj45') return dev.rj45 === null ? null : { speed: Math.min(g.speed, dev.rj45), module: false }
  // An SFP cage takes an SFP device directly, and a copper-only one through an RJ45 module.
  if (dev.sfp !== null) return { speed: Math.min(g.speed, dev.sfp), module: false }
  return dev.rj45 === null ? null : { speed: Math.min(g.speed, dev.rj45), module: true }
}

interface Placed {
  group: Group
  speed: number
  module: boolean
}

/**
 * Whether every device that isn't powered over PoE can have a switch port: copper or SFP-style, on any switch
 * in the plan (and a gateway's LAN ports). PoE-powered devices already take PoE ports (`poeDevices` of them),
 * so those ports are no longer free; the rest of the ports are what the devices below can have, a spare PoE
 * port included. A copper-only device may use an SFP cage through a module, but only when no copper port is left.
 * What a switch's own uplink takes is not counted.
 */
export function netPortCheck(lines: DerivedLine[], poeDevices: number, poePowered: (l: DerivedLine) => boolean): PlanCheck[] {
  const devices: Device[] = lines.flatMap((l) => {
    if (isSwitch(l) || isGateway(l) || poePowered(l)) return []
    const d = deviceOf(l)
    return d ? Array.from({ length: l.view.line.qty }, () => d) : []
  })
  if (devices.length === 0) return []

  const suppliers = lines.filter((l) => isSwitch(l) || isGateway(l))
  if (suppliers.length === 0) {
    return [{ id: 'net-ports', label: 'Switch ports', verdict: 'info', shortfall: true, text: `${devices.length} ${devices.length === 1 ? 'device needs' : 'devices need'} a switch port (${[...new Set(devices.map((d) => name(d.line)))].join(', ')}); nothing in the plan provides switch ports.` }]
  }
  const units = suppliers.flatMap((l) => Array.from({ length: l.view.line.qty }, (_, n) => ({ line: l, n })))
  const unitName = (u: { line: DerivedLine; n: number }) => `${name(u.line)}${u.line.view.line.qty > 1 ? ` #${u.n + 1}` : ''}`
  const unsure = suppliers.filter((l) => !l.derived?.known.ports)
  const groups = units.flatMap((u, i) => (u.line.derived?.known.ports ? groupsOf(u.line, i) : []))
  const total = groups.reduce((n, g) => n + g.free, 0)

  // PoE-powered devices are on PoE ports, fewest-speed ones first being the likeliest.
  let poeLeft = poeDevices
  for (const g of groups.filter((x) => x.poe).sort((a, b) => a.speed - b.speed)) {
    const take = Math.min(g.free, poeLeft)
    g.free -= take
    poeLeft -= take
  }
  const free = groups.reduce((n, g) => n + g.free, 0)

  // Devices with fewer choices first (an SFP-only one needs a cage); each takes the port it runs fastest on, without a module if it can,
  // and of those the slowest, so quicker ports stay free for devices that can use them.
  const order = devices.map((_, i) => i).sort((a, b) => {
    const kind = (d: Device) => (d.rj45 === null ? 0 : d.sfp === null ? 2 : 1)
    return kind(devices[a]!) - kind(devices[b]!) || Math.max(devices[b]!.rj45 ?? 0, devices[b]!.sfp ?? 0) - Math.max(devices[a]!.rj45 ?? 0, devices[a]!.sfp ?? 0)
  })
  const placed: (Placed | null)[] = devices.map(() => null)
  for (const i of order) {
    let best: Placed | null = null
    for (const g of groups) {
      if (g.free <= 0) continue
      const f = fit(devices[i]!, g)
      if (!f) continue
      const better = best === null || Number(f.module) - Number(best.module) < 0 || (f.module === best.module && (f.speed > best.speed || (f.speed === best.speed && (g.speed < best.group.speed || (g.speed === best.group.speed && g.media !== 'either' && best.group.media === 'either')))))
      if (better) best = { group: g, ...f }
    }
    if (best) {
      best.group.free--
      placed[i] = best
    }
  }

  const lost = placed.filter((p) => p === null).length
  const spare = groups.reduce((n, g) => n + g.free, 0)
  const names = (ds: Device[]) => [...new Set(ds.map((d) => name(d.line)))].join(', ')
  const stats: NetStats = { unplaced: lost, spare }
  const modules = placed.filter((p) => p?.module).length

  const detail = units.flatMap((u, k) => {
    const on = new Map<string, { group: string; what: string; n: number }>()
    devices.forEach((d, i) => {
      const at = placed[i]
      if (!at || at.group.unit !== k) return
      const best = Math.max(d.rj45 ?? 0, d.sfp ?? 0)
      const what = `${name(d.line)}${at.module ? ' (needs an SFP module)' : ''}${at.speed < best ? ` (runs at ${formatSpeed(at.speed)})` : ''}`
      const key = `${at.group.label}|${what}`
      on.set(key, { group: at.group.label, what, n: (on.get(key)?.n ?? 0) + 1 })
    })
    const rows = [...on.values()].map((r) => `${r.group} ports: ${r.n} × ${r.what}`)
    return rows.length === 0 ? [] : [{ title: unitName(u), rows }]
  })
  if (lost > 0) {
    const counts = new Map<string, number>()
    devices.forEach((d, i) => placed[i] === null && counts.set(name(d.line), (counts.get(name(d.line)) ?? 0) + 1))
    detail.push({ title: 'No switch port left for', rows: [...counts].map(([nm, c]) => `${c} × ${nm}`) })
  }
  const withDetail = detail.length > 0 ? { detail } : {}

  if (lost > 0) {
    const missing = devices.filter((_, i) => placed[i] === null)
    const sfpOnly = missing.filter((d) => d.rj45 === null)
    const why = sfpOnly.length > 0 ? `; ${names(sfpOnly)} ${sfpOnly.length === 1 ? 'needs' : 'need'} an SFP-style port` : ''
    if (unsure.length > 0) {
      return [{ id: 'net-ports', label: 'Switch ports', verdict: 'unknown', text: `Can't tell: no ports are known for ${unsure.map(name).join(', ')}. Without them, ${lost} of ${devices.length} ${devices.length === 1 ? 'device' : 'devices'} (${names(missing)}) ${lost === 1 ? 'has' : 'have'} no switch port: ${portsLabel(free)} free after the PoE-powered devices.`, net: stats, ...withDetail }]
    }
    return [{ id: 'net-ports', label: 'Switch ports', verdict: 'bad', shortfall: true, text: `${lost} of ${devices.length} ${devices.length === 1 ? 'device' : 'devices'} that ${devices.length === 1 ? 'needs' : 'need'} a switch port can't be given one (${names(missing)}): ${portsLabel(free)} free of ${total} after the PoE-powered devices${why}.`, net: stats, ...withDetail }]
  }
  const sentences = [`${devices.length} ${devices.length === 1 ? 'device needs' : 'devices need'} a switch port (${names(devices)}); ${portsLabel(spare)} ${spare === 1 ? 'is' : 'are'} spare after the PoE-powered devices.`, modules > 0 && `${modules} copper ${modules === 1 ? 'device goes' : 'devices go'} in an SFP port with a module.`, unsure.length > 0 && `No ports are known for ${unsure.map(name).join(', ')}, so its ports aren't counted.`].filter(Boolean)
  return [{ id: 'net-ports', label: 'Switch ports', verdict: 'ok', text: sentences.join(' '), net: stats, ...withDetail }]
}
