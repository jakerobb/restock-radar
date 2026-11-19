import type { Derived } from '../api/types'
import type { DerivedLine, PlanCheck } from './planChecks'

/**
 * The roles a plan needs filled by something that runs them, besides the NVR check's Protect: a gateway
 * (routes and firewalls), and the UniFi Network, Access and Talk controllers (the applications that manage
 * switches and access points, door hubs and readers, and phones). Many products fill several: a Dream Machine
 * is a gateway and runs Network, Protect and Talk; a Cloud Key runs Network and more but routes nothing.
 */
export type Role = 'gateway' | 'network' | 'access' | 'talk'
export const ROLES: readonly Role[] = ['gateway', 'network', 'access', 'talk']
export const ROLE_LABEL: Record<Role, string> = { gateway: 'Gateway', network: 'Network controller', access: 'Access controller', talk: 'Talk controller' }

const metric = (d: Derived | null, n: string): number => {
  const v = d?.metrics.find((m) => m.name === n)?.value
  return typeof v === 'number' ? v : 0
}

const metricOf = (d: Derived | null, n: string) => d?.metrics.find((m) => m.name === n)

/** "5 Gbps", "800 Mbps": a throughput as the store gives it, in Mbps. */
export function formatRate(mbps: number): string {
  return mbps >= 1000 ? `${Math.round((mbps / 1000) * 100) / 100} Gbps` : `${mbps} Mbps`
}

/** "5 Gbps gateway" (the figure is its IDS/IPS throughput, what it can inspect), or just "gateway" when that isn't known. */
export function gatewayLabel(d: Derived | null): string {
  const v = metric(d, 'ids_ips_throughput_mbps')
  return v > 0 ? `${formatRate(v)} gateway` : 'gateway'
}

/** Whether a product fills a role: a gateway is a product of that type; a controller says it runs the application. */
export function fills(type: string | undefined, d: Derived | null, role: Role): boolean {
  return role === 'gateway' ? type === 'Gateways' : metric(d, `app_${role}`) > 0
}

/** The applications a product runs (Protect too, though that role is the NVR check's), in the store's order. */
export function appsRun(d: Derived | null): string[] {
  return (['network', 'protect', 'access', 'talk'] as const).filter((a) => metric(d, `app_${a}`) > 0)
}

/** Store categories of door access products (hubs, intercoms, kits that contain a hub, readers), which are managed by UniFi Access. */
const ACCESS_CATEGORIES = new Set(['door-access-hub', 'door-access-intercoms', 'door-access-starter-kit', 'door-access-readers'])
/** Store categories of phones and phone adapters, which are managed by UniFi Talk. */
const TALK_CATEGORIES = new Set(['managed-voip'])

const onNetwork = (l: DerivedLine): boolean => !!l.derived?.known.ports && l.derived.ports.some((p) => p.role === 'data' && (p.media === 'rj45' || p.media.startsWith('sfp')))

/** The lines that need the role filled. A gateway and a Network controller are needed by anything on the network. */
export function needers(lines: DerivedLine[], role: Role): DerivedLine[] {
  switch (role) {
    case 'gateway':
    case 'network':
      return lines.filter(onNetwork)
    case 'access':
      return lines.filter((l) => ACCESS_CATEGORIES.has(l.view.product?.category ?? ''))
    case 'talk':
      return lines.filter((l) => TALK_CATEGORIES.has(l.view.product?.category ?? ''))
  }
}

const name = (l: DerivedLine) => l.view.product?.title ?? l.view.line.ref
const count = (ls: DerivedLine[]) => ls.reduce((n, l) => n + l.view.line.qty, 0)

const MISSING: Record<Role, (users: DerivedLine[]) => string> = {
  gateway: () => 'No gateway in the plan to route and protect the network.',
  network: () => "No Network controller in the plan: something has to run UniFi Network (a gateway or console that does) to manage the switches and access points.",
  access: (u) => `${count(u)} door access ${count(u) === 1 ? 'device needs' : 'devices need'} an Access controller (a console or NVR that runs UniFi Access), and nothing in the plan runs it.`,
  talk: (u) => `${count(u)} ${count(u) === 1 ? 'phone needs' : 'phones need'} a Talk controller (a console that runs UniFi Talk), and nothing in the plan runs it.`,
}
const FILLED: Record<Role, (by: DerivedLine[]) => string> = {
  gateway: (by) => `${by.map((l) => `${name(l)}${metric(l.derived, 'ids_ips_throughput_mbps') > 0 ? ` (${formatRate(metric(l.derived, 'ids_ips_throughput_mbps'))} IDS/IPS)` : ''}`).join(', ')} ${by.length === 1 ? 'is' : 'are'} the gateway.`,
  network: (by) => `${by.map(name).join(', ')} ${by.length === 1 ? 'runs' : 'run'} UniFi Network.`,
  access: (by) => `${by.map(name).join(', ')} ${by.length === 1 ? 'runs' : 'run'} UniFi Access.`,
  talk: (by) => `${by.map(name).join(', ')} ${by.length === 1 ? 'runs' : 'run'} UniFi Talk.`,
}

const NETWORK_TYPES = new Set(['Switches', 'WiFi', 'Gateways'])
const HUB_CATEGORIES = new Set(['door-access-hub', 'door-access-intercoms', 'door-access-starter-kit'])
const qtyOf = (ls: DerivedLine[]) => ls.reduce((n, l) => n + l.view.line.qty, 0)

/** What a controller manages, and which lines in the plan count against it. */
const CAPACITY: Partial<Record<Role, { metric: string; noun: string; counted: (lines: DerivedLine[]) => DerivedLine[] }>> = {
  // The devices UniFi Network manages: gateways, switches, access points and the like (cameras and door hubs have their own applications).
  network: { metric: 'managed_devices', noun: 'UniFi devices', counted: (ls) => ls.filter((l) => NETWORK_TYPES.has(l.view.product?.type ?? '') || l.view.product?.category === 'internet-solutions') },
  // A starter kit includes a hub, and an intercom is one.
  access: { metric: 'managed_access_hubs', noun: 'access hubs', counted: (ls) => ls.filter((l) => HUB_CATEGORIES.has(l.view.product?.category ?? '')) },
}

/** What the plan's controllers for a role manage, the largest (a console that says "100+" is at least 100), or null when none says. */
function capacityOf(live: DerivedLine[], metricName: string) {
  const known = live.flatMap((l) => {
    const m = metricOf(l.derived, metricName)
    return m && m.value > 0 ? [{ line: l, value: m.value, plus: m.at_least }] : []
  })
  return known.reduce<(typeof known)[number] | null>((a, b) => (a === null || b.value > a.value ? b : a), null)
}

/** Controllers in the plan that manage fewer devices than the plan has, which a bigger one would replace. */
export function undersized(lines: DerivedLine[]): DerivedLine[] {
  return roleCheck(lines).flatMap((c) => {
    const role = c.roleShortfall
    const cap = role && CAPACITY[role]
    if (!role || !cap || !c.id.endsWith('-capacity')) return []
    return lines.filter((l) => l.view.state === 'in' && fills(l.view.product?.type, l.derived, role) && (metricOf(l.derived, cap.metric)?.value ?? 0) > 0)
  })
}

function capacityCheck(role: Role, noun: string, need: number, live: DerivedLine[], best: ReturnType<typeof capacityOf>): PlanCheck {
  const base = { id: `role-${role}-capacity`, label: `${ROLE_LABEL[role]} capacity` }
  if (!best) return { ...base, verdict: 'unknown', text: `Can't tell how many ${noun} ${live.map(name).join(', ')} manages: the store doesn't say. The plan has ${need}.` }
  const shown = `${best.value.toLocaleString('en-US')}${best.plus ? '+' : ''}`
  if (need <= best.value) return { ...base, verdict: 'ok', text: `${need} ${noun} in the plan; ${name(best.line)} manages ${shown}.` }
  if (best.plus) return { ...base, verdict: 'warn', roleShortfall: role, text: `The plan has ${need} ${noun}, but ${name(best.line)} is only listed for ${shown}, so it may not manage them all.` }
  return { ...base, verdict: 'bad', roleShortfall: role, text: `The plan has ${need} ${noun}, over the ${shown} that ${name(best.line)} manages.` }
}

/**
 * Whether the plan has something to fill each role it needs, and which role is missing when it hasn't. A role
 * only filled by something that can't be bought now counts as missing too (with a warning that says so).
 */
export function roleCheck(lines: DerivedLine[]): PlanCheck[] {
  const out: PlanCheck[] = []
  for (const role of ROLES) {
    if (needers(lines, role).length === 0) continue
    const by = lines.filter((l) => fills(l.view.product?.type, l.derived, role))
    const live = by.filter((l) => l.view.state === 'in')
    const base = { id: `role-${role}`, label: ROLE_LABEL[role] }
    if (by.length === 0) out.push({ ...base, verdict: 'warn', roleShortfall: role, text: MISSING[role](needers(lines, role)) })
    else if (live.length === 0) out.push({ ...base, verdict: 'warn', roleShortfall: role, text: `${by.map(name).join(', ')} ${by.length === 1 ? "isn't" : "aren't"} in stock, so nothing in the plan that can be had fills this role.` })
    else {
      out.push({ ...base, verdict: 'ok', text: FILLED[role](live) })
      const cap = CAPACITY[role]
      const need = cap ? qtyOf(cap.counted(lines)) : 0
      if (cap && need > 0) out.push(capacityCheck(role, cap.noun, need, live, capacityOf(live, cap.metric)))
    }
  }
  return out
}
