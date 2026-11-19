import type { Derived } from '../api/types'
import { buildCatalog } from './catalog'
import { viewLine, type PlanLine } from './plan'
import { planChecks, type DerivedLine } from './planChecks'
import { findRoles } from './roleFinder'
import { derived, port, product, variant } from '../test/fixtures'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
const app = (...names: string[]) => names.map((n) => ({ name: `app_${n}`, value: 1, unit: '', at_least: false, raw: '' }))

interface Spec {
  slug: string
  type: string
  category?: string
  cents?: number
  status?: 'Available' | 'SoldOut'
  d?: Partial<Derived>
}
const world = (specs: Spec[]) => {
  const products = specs.map((s, i) => product({ id: s.slug, slug: s.slug, title: s.slug, type: s.type, category: s.category ?? '', variants: [variant({ id: s.slug, num: i + 1, sku: s.slug.toUpperCase(), price_cents: s.cents ?? 10000, status: s.status ?? 'Available' })] }))
  const ds = specs.map((s) => derived({ slug: s.slug, known, ports: [port({ count: 8 })], ...s.d }))
  const map = new Map(products.map((p) => [`${p.region}/${p.slug}`, p]))
  const plan = (...items: [string, number][]): DerivedLine[] =>
    items.map(([slug, qty]) => {
      const l: PlanLine = { ref: `us/${slug}`, sku: slug.toUpperCase(), qty, addedCents: null }
      return { view: viewLine(l, map), derived: ds.find((d) => d.slug === slug) ?? null }
    })
  return { rows: buildCatalog(products, ds), map, plan }
}
const roleChecks = (lines: DerivedLine[]) => Object.fromEntries(planChecks(lines).filter((c) => c.id.startsWith('role-')).map((c) => [c.id, c]))

const specs: Spec[] = [
  { slug: 'ap', type: 'WiFi' },
  { slug: 'switch', type: 'Switches' },
  { slug: 'ucg-ultra', type: 'Gateways', cents: 20900, d: { metrics: app('network') } },
  { slug: 'udm-pro', type: 'Gateways', cents: 37900, d: { metrics: app('network', 'protect', 'talk') } },
  { slug: 'uxg-lite', type: 'Gateways', cents: 8900 }, // a gateway that needs a controller
  { slug: 'cloud-key', type: 'Accessories', cents: 19900, d: { metrics: app('network', 'protect', 'access', 'talk') } },
  { slug: 'hub', type: 'Door Access', category: 'door-access-hub' },
  { slug: 'phone', type: 'Phones', category: 'managed-voip' },
]
const w = world(specs)

describe('roles: a gateway and the controllers', () => {
  it('says nothing for a plan with nothing on the network', () => {
    expect(roleChecks(w.plan())).toEqual({})
  })

  it('wants a gateway and a Network controller for anything on the network, and offers to fix it', () => {
    const c = roleChecks(w.plan(['ap', 2], ['switch', 1]))
    expect(c['role-gateway']).toMatchObject({ verdict: 'warn', roleShortfall: 'gateway', text: expect.stringContaining('No gateway') })
    expect(c['role-network']).toMatchObject({ verdict: 'warn', roleShortfall: 'network' })
    expect(c['role-access']).toBeUndefined()
    expect(c['role-talk']).toBeUndefined()
  })

  it('is satisfied by one product filling both roles', () => {
    const c = roleChecks(w.plan(['ap', 2], ['ucg-ultra', 1]))
    expect(c['role-gateway']).toMatchObject({ verdict: 'ok', text: 'ucg-ultra is the gateway.' })
    expect(c['role-network']).toMatchObject({ verdict: 'ok', text: 'ucg-ultra runs UniFi Network.' })
  })

  it('wants a controller even when the gateway is there, if it does not run Network', () => {
    const c = roleChecks(w.plan(['ap', 1], ['uxg-lite', 1]))
    expect(c['role-gateway']?.verdict).toBe('ok')
    expect(c['role-network']).toMatchObject({ verdict: 'warn', roleShortfall: 'network' })
    // A console fills it without being a gateway.
    expect(roleChecks(w.plan(['ap', 1], ['uxg-lite', 1], ['cloud-key', 1]))['role-network']?.verdict).toBe('ok')
  })

  it('wants an Access controller for door hubs and a Talk controller for phones', () => {
    const c = roleChecks(w.plan(['hub', 2], ['phone', 3], ['ucg-ultra', 1]))
    expect(c['role-access']).toMatchObject({ verdict: 'warn', roleShortfall: 'access', text: expect.stringContaining('2 door access devices need an Access controller') })
    expect(c['role-talk']).toMatchObject({ verdict: 'warn', roleShortfall: 'talk', text: expect.stringContaining('3 phones need a Talk controller') })
    const ok = roleChecks(w.plan(['hub', 2], ['phone', 3], ['cloud-key', 1]))
    expect(ok['role-access']).toMatchObject({ verdict: 'ok', text: 'cloud-key runs UniFi Access.' })
    expect(ok['role-talk']?.verdict).toBe('ok')
  })

  it('does not count a role filled only by something that can not be bought now', () => {
    const sold = world(specs.map((s) => (s.slug === 'udm-pro' ? { ...s, status: 'SoldOut' as const } : s)))
    expect(roleChecks(sold.plan(['ap', 1], ['udm-pro', 1]))['role-gateway']).toMatchObject({ verdict: 'warn', roleShortfall: 'gateway', text: expect.stringContaining("isn't in stock") })
  })

  it('says the NVR check is the Protect controller', () => {
    const cam = world([{ slug: 'cam', type: 'Cameras', category: 'physical-security-bullet', d: { metrics: [{ name: 'camera_megapixels', value: 4, unit: 'MP', at_least: false, raw: '' }] } }])
    expect(planChecks(cam.plan(['cam', 2])).find((c) => c.id === 'nvr')).toMatchObject({ label: 'Protect controller (NVR)', text: expect.stringContaining('Protect controller') })
  })
})

describe('findRoles', () => {
  const options = (...items: [string, number][]) => findRoles(w.plan(...items), w.rows, w.map).options.map((o) => `${o.label}: ${o.rows.map((r) => r.product.slug).join(' + ')}`)

  it('suggests the cheapest product that fills every missing role, and the one running the most applications', () => {
    expect(options(['ap', 2])).toEqual(['Cheapest that fits: ucg-ultra', 'Runs the most applications: udm-pro'])
  })

  it('suggests only a controller when the gateway is there', () => {
    // uxg-lite is a gateway without Network; anything running Network fills the rest (a gateway, or the console, which is cheaper).
    expect(options(['ap', 1], ['uxg-lite', 1])[0]).toBe('Cheapest that fits: cloud-key')
  })

  it('suggests a pair when nothing does it all', () => {
    // A Talk controller and an Access controller, with only the console running Access: the console does both, so one product.
    expect(options(['hub', 1], ['phone', 1], ['ucg-ultra', 1])).toEqual(['Cheapest that fits: cloud-key'])
    // Without it, the gateway and the Access controller come from different products.
    const noKey = world(specs.filter((s) => s.slug !== 'udm-pro').map((s) => (s.slug === 'cloud-key' ? { ...s, d: { metrics: app('access') } } : s)))
    const found = findRoles(noKey.plan(['hub', 1], ['phone', 1], ['ucg-ultra', 1]), noKey.rows, noKey.map)
    expect(found.missing).toEqual(['access', 'talk'])
    expect(found.options).toEqual([])
  })

  it('replaces what fills a role but can not be bought now', () => {
    const sold = world(specs.map((s) => (s.slug === 'ucg-ultra' ? { ...s, status: 'SoldOut' as const } : s)))
    const found = findRoles(sold.plan(['ap', 1], ['ucg-ultra', 1]), sold.rows, sold.map)
    expect(found.options[0]?.replaces.map((l) => l.view.line.ref)).toEqual(['us/ucg-ultra'])
    expect(found.options[0]?.rows[0]?.product.slug).not.toBe('ucg-ultra')
  })

  it('has nothing to suggest when nothing is missing', () => {
    expect(findRoles(w.plan(['ap', 1], ['udm-pro', 1]), w.rows, w.map).options).toEqual([])
  })
})
