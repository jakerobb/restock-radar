import type { Derived, Product } from '../api/types'
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

/** The controllers that can run somewhere other than on a product in the plan (Protect, which records, can't). */
export type HostedRole = Exclude<Role, 'gateway'>
export const HOSTED_ROLES: readonly HostedRole[] = ['network', 'access', 'talk']
/** Where a controller runs when it isn't on a product in the plan: on a machine you run yourself (UniFi's own cloud hosting is a product, below). */
export type HostedWhere = 'self'
/** The controllers the plan's owner has decided to run themselves; each is an entry in the plan, but not a product. */
export type Hosting = Partial<Record<HostedRole, HostedWhere>>
export const APP_NAME: Record<HostedRole, string> = { network: 'UniFi Network', access: 'UniFi Access', talk: 'UniFi Talk' }

/** What the store says of a product, as far as roles go. */
export type ProductInfo = Pick<Product, 'type' | 'slug'>

/**
 * Products that are a hosted controller. The store gives them no specifications, so what they run and manage
 * is stated here: Official UniFi Hosting (a monthly subscription) runs UniFi Network for up to 1,000 devices.
 */
const HOSTED_PRODUCTS: Record<string, { roles: readonly HostedRole[]; managedDevices: number; note: string }> = {
  'unifi-hosting': { roles: ['network'], managedDevices: 1000, note: 'A monthly subscription: the price is per month.' },
}
/** A note about a product that is a hosted controller, or undefined. */
export const hostedNote = (p: ProductInfo | undefined): string | undefined => (p ? HOSTED_PRODUCTS[p.slug]?.note : undefined)

const metric = (d: Derived | null, n: string): number => {
  const v = d?.metrics.find((m) => m.name === n)?.value
  return typeof v === 'number' ? v : 0
}

/** "5 Gbps", "800 Mbps": a throughput as the store gives it, in Mbps. */
export function formatRate(mbps: number): string {
  return mbps >= 1000 ? `${Math.round((mbps / 1000) * 100) / 100} Gbps` : `${mbps} Mbps`
}

/** "5 Gbps gateway" (the figure is its IDS/IPS throughput, what it can inspect), or just "gateway" when that isn't known. */
export function gatewayLabel(d: Derived | null): string {
  const v = metric(d, 'ids_ips_throughput_mbps')
  return v > 0 ? `${formatRate(v)} gateway` : 'gateway'
}

/** A gateway: a product of that type, or any that states what it can inspect (the UXG gateways are filed as accessories). */
export const isGatewayProduct = (p: ProductInfo | undefined, d: Derived | null): boolean => p?.type === 'Gateways' || metric(d, 'ids_ips_throughput_mbps') > 0

/** Whether a product fills a role: a gateway, or a controller that says it runs the application (or is a hosted controller). */
export function fills(p: ProductInfo | undefined, d: Derived | null, role: Role): boolean {
  if (role === 'gateway') return isGatewayProduct(p, d)
  return metric(d, `app_${role}`) > 0 || !!(p && HOSTED_PRODUCTS[p.slug]?.roles.includes(role))
}

/** The applications a product runs (Protect too, though that role is the NVR check's), in the store's order. */
export function appsRun(p: ProductInfo | undefined, d: Derived | null): string[] {
  return (['network', 'protect', 'access', 'talk'] as const).filter((a) => metric(d, `app_${a}`) > 0 || !!(p && a !== 'protect' && HOSTED_PRODUCTS[p.slug]?.roles.includes(a)))
}

/** How many devices (managed_devices) or access hubs (managed_access_hubs) a product manages, and whether that is a minimum; null when it doesn't say. */
export function managedOf(p: ProductInfo | undefined, d: Derived | null, name: string): { value: number; plus: boolean } | null {
  const m = d?.metrics.find((x) => x.name === name)
  if (m && m.value > 0) return { value: m.value, plus: m.at_least }
  const hosted = p && name === 'managed_devices' ? HOSTED_PRODUCTS[p.slug] : undefined
  return hosted ? { value: hosted.managedDevices, plus: false } : null
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
  network: { metric: 'managed_devices', noun: 'UniFi devices', counted: (ls) => ls.filter((l) => NETWORK_TYPES.has(l.view.product?.type ?? '') || isGatewayProduct(l.view.product, l.derived) || l.view.product?.category === 'internet-solutions') },
  // A starter kit includes a hub, and an intercom is one.
  access: { metric: 'managed_access_hubs', noun: 'access hubs', counted: (ls) => ls.filter((l) => HUB_CATEGORIES.has(l.view.product?.category ?? '')) },
}

/** What the plan's controllers for a role manage, the largest (a console that says "100+" is at least 100), or null when none says. */
function capacityOf(live: DerivedLine[], metricName: string) {
  const known = live.flatMap((l) => {
    const m = managedOf(l.view.product, l.derived, metricName)
    return m ? [{ line: l, value: m.value, plus: m.plus }] : []
  })
  return known.reduce<(typeof known)[number] | null>((a, b) => (a === null || b.value > a.value ? b : a), null)
}

/** Controllers in the plan that manage fewer devices than the plan has, which a bigger one would replace. */
export function undersized(lines: DerivedLine[], hosting: Hosting = {}): DerivedLine[] {
  return roleCheck(lines, hosting).flatMap((c) => {
    const role = c.roleShortfall
    const cap = role && CAPACITY[role]
    if (!role || !cap || !c.id.endsWith('-capacity')) return []
    return lines.filter((l) => l.view.state === 'in' && fills(l.view.product, l.derived, role) && managedOf(l.view.product, l.derived, cap.metric) !== null)
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
export function roleCheck(lines: DerivedLine[], hosting: Hosting = {}): PlanCheck[] {
  const out: PlanCheck[] = []
  for (const role of ROLES) {
    if (role === 'network') {
      // A site has one Network controller. Two probably means one belongs to another site (or a mistake).
      const runners = lines.filter((l) => fills(l.view.product, l.derived, 'network'))
      const count = qtyOf(runners) + (hosting.network ? 1 : 0)
      if (count > 1) {
        const names = [...runners.map((l) => `${l.view.line.qty > 1 ? `${l.view.line.qty} × ` : ''}${name(l)}`), ...(hosting.network ? ['a self-hosted controller'] : [])]
        out.push({ id: 'role-network-many', label: 'Network controllers', verdict: 'warn', text: `${count} things in the plan run UniFi Network (${names.join(', ')}). A site has one Network controller, so the extra ones probably belong to another site; only the largest is counted here.` })
      }
    }
    if (needers(lines, role).length === 0) continue
    // A controller the owner has decided to run elsewhere is filled, whatever the plan holds.
    const where = role === 'gateway' ? undefined : hosting[role]
    if (role !== 'gateway' && where === 'self') {
      const text = `Self-hosted: you run ${APP_NAME[role]} yourself (UniFi OS Server, or the application on a machine of your own). How many devices it manages isn't checked.`
      out.push({ id: `role-${role}`, label: ROLE_LABEL[role], verdict: 'ok', hosted: role, text })
      continue
    }
    const by = lines.filter((l) => fills(l.view.product, l.derived, role))
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
