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
  gateway: (by) => `${by.map(name).join(', ')} ${by.length === 1 ? 'is' : 'are'} the gateway.`,
  network: (by) => `${by.map(name).join(', ')} ${by.length === 1 ? 'runs' : 'run'} UniFi Network.`,
  access: (by) => `${by.map(name).join(', ')} ${by.length === 1 ? 'runs' : 'run'} UniFi Access.`,
  talk: (by) => `${by.map(name).join(', ')} ${by.length === 1 ? 'runs' : 'run'} UniFi Talk.`,
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
    else out.push({ ...base, verdict: 'ok', text: FILLED[role](live) })
  }
  return out
}
