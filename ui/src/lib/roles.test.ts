import type { Derived } from '../api/types'
import { buildCatalog } from './catalog'
import { viewLine, type PlanLine } from './plan'
import { planChecks, type DerivedLine } from './planChecks'
import { findRoles } from './roleFinder'
import { formatRate, gatewayLabel } from './roles'
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
    expect(options(['ap', 2])).toEqual(['Cheapest that fits: ucg-ultra', 'Runs the most applications: udm-pro', 'Cheapest as separate products: uxg-lite + cloud-key'])
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

describe('what a controller manages', () => {
  const m = (name: string, value: number, at_least = false) => ({ name, value, unit: '', at_least, raw: '' })
  const set: Spec[] = [
    { slug: 'ap', type: 'WiFi' },
    { slug: 'sw', type: 'Switches' },
    { slug: 'hub', type: 'Door Access', category: 'door-access-hub' },
    { slug: 'small', type: 'Gateways', cents: 14000, d: { metrics: [...app('network'), m('managed_devices', 3, true), m('ids_ips_throughput_mbps', 1000)] } },
    { slug: 'exact', type: 'Gateways', cents: 20000, d: { metrics: [...app('network', 'access'), m('managed_devices', 3), m('managed_access_hubs', 2), m('ids_ips_throughput_mbps', 5000)] } },
    { slug: 'big', type: 'Gateways', cents: 40000, d: { metrics: [...app('network', 'access'), m('managed_devices', 100, true), m('managed_access_hubs', 50), m('ids_ips_throughput_mbps', 3500)] } },
    { slug: 'silent', type: 'Gateways', cents: 9000, d: { metrics: app('network') } },
  ]
  const x = world(set)
  const caps = (...items: [string, number][]) => Object.fromEntries(planChecks(x.plan(...items)).filter((c) => c.id.endsWith('-capacity')).map((c) => [c.id, c]))

  it('is satisfied when the controller manages at least as many UniFi devices as the plan has', () => {
    // 2 access points, a switch and the gateway itself: 4 devices.
    expect(caps(['ap', 2], ['sw', 1], ['big', 1])['role-network-capacity']).toMatchObject({ verdict: 'ok', text: '4 UniFi devices in the plan; big manages 100+.' })
    expect(caps(['ap', 2], ['exact', 1])['role-network-capacity']).toMatchObject({ verdict: 'ok' }) // 3 of 3
  })

  it('is bad when the plan has more than a controller that states an exact number manages, and offers to fix it', () => {
    expect(caps(['ap', 3], ['exact', 1])['role-network-capacity']).toMatchObject({ verdict: 'bad', roleShortfall: 'network', text: 'The plan has 4 UniFi devices, over the 3 that exact manages.' })
  })

  it('only warns when the figure is a minimum ("3+"), since it may manage more', () => {
    expect(caps(['ap', 3], ['small', 1])['role-network-capacity']).toMatchObject({ verdict: 'warn', roleShortfall: 'network', text: expect.stringContaining('only listed for 3+') })
  })

  it('says it can’t tell when the store gives no figure', () => {
    expect(caps(['ap', 3], ['silent', 1])['role-network-capacity']).toMatchObject({ verdict: 'unknown', text: expect.stringContaining("Can't tell how many UniFi devices silent manages") })
    expect(caps(['ap', 3], ['silent', 1])['role-network-capacity']?.roleShortfall).toBeUndefined()
  })

  it('goes by the largest controller when there are several', () => {
    expect(caps(['ap', 5], ['exact', 1], ['big', 1])['role-network-capacity']).toMatchObject({ verdict: 'ok', text: expect.stringContaining('big manages 100+') })
  })

  it('counts door access hubs against what the Access controller manages', () => {
    expect(caps(['hub', 2], ['exact', 1])['role-access-capacity']).toMatchObject({ verdict: 'ok', text: '2 access hubs in the plan; exact manages 2.' })
    expect(caps(['hub', 3], ['exact', 1])['role-access-capacity']).toMatchObject({ verdict: 'bad', text: 'The plan has 3 access hubs, over the 2 that exact manages.' })
  })

  it('does not check capacity when the role is missing or nothing counts against it', () => {
    expect(caps(['ap', 3])).toEqual({})
    expect(caps(['hub', 2], ['small', 1])['role-access-capacity']).toBeUndefined() // small doesn't run Access
  })

  it('names the gateway’s throughput in the check', () => {
    expect(roleChecks(x.plan(['ap', 1], ['exact', 1]))['role-gateway']?.text).toBe('exact (5 Gbps IDS/IPS) is the gateway.')
  })

  it('suggests a bigger controller, replacing the one that is too small', () => {
    const found = findRoles(x.plan(['ap', 5], ['exact', 1]), x.rows, x.map)
    expect(found.options[0]).toMatchObject({ rows: [expect.objectContaining({ product: expect.objectContaining({ slug: 'big' }) })] })
    expect(found.options[0]?.replaces.map((l) => l.view.line.ref)).toEqual(['us/exact'])
    expect(found.options[0]?.undersized).toHaveLength(1)
    // One that doesn't state its capacity is in the full list, flagged, but isn't suggested.
    const all = findRoles(x.plan(['ap', 5], ['exact', 1]), x.rows, x.map).all
    expect(all.map((o) => `${o.rows[0]?.product.slug}${o.unverified ? ' (unverified)' : ''}`)).toEqual(['silent (unverified)', 'big'])
    expect(found.options.map((o) => o.rows[0]?.product.slug)).toEqual(['big'])
  })

  it('formats the gateway figure for the finder', () => {
    expect([gatewayLabel(x.plan(['big', 1])[0]!.derived), gatewayLabel(x.plan(['silent', 1])[0]!.derived), formatRate(800), formatRate(10000)]).toEqual(['3.5 Gbps gateway', 'gateway', '800 Mbps', '10 Gbps'])
  })
})

describe('running a controller somewhere else', () => {
  const lines = (...items: [string, number][]) => w.plan(...items)
  const hostedBy = (lines2: DerivedLine[], hosting: Parameters<typeof planChecks>[1]) => Object.fromEntries(planChecks(lines2, hosting).map((c) => [c.id, c]))

  it('counts a self-hosted controller as filling the role, and says capacity is not checked', () => {
    const plan = lines(['ap', 2], ['uxg-lite', 1])
    expect(hostedBy(plan, {})['role-network']).toMatchObject({ verdict: 'warn', roleShortfall: 'network' })
    expect(hostedBy(plan, { network: 'self' })['role-network']).toMatchObject({ verdict: 'ok', hosted: 'network', text: expect.stringContaining('Self-hosted') })
    expect(hostedBy(plan, { network: 'self' })['role-network-capacity']).toBeUndefined()
  })

  it('does not fill a gateway, which has to be hardware', () => {
    expect(hostedBy(lines(['ap', 2]), { network: 'self' })['role-gateway']).toMatchObject({ verdict: 'warn', roleShortfall: 'gateway' })
  })

  it('offers the missing controllers (not the gateway) to be run elsewhere, and then wants only the gateway', () => {
    const plan = lines(['ap', 2], ['hub', 1])
    const found = findRoles(plan, w.rows, w.map)
    expect(found.missing).toEqual(['gateway', 'network', 'access'])
    expect(found.hostable).toEqual(['network', 'access'])
    const hosted = findRoles(plan, w.rows, w.map, { network: 'self', access: 'self' })
    expect(hosted.missing).toEqual(['gateway'])
    expect(hosted.hostable).toEqual([])
    // Any gateway does then; the cheapest is the one that does nothing else.
    expect(hosted.options[0]).toMatchObject({ label: 'Cheapest that fits', rows: [expect.objectContaining({ product: expect.objectContaining({ slug: 'uxg-lite' }) })] })
  })

  it('offers a gateway and a controller as separate products, so a UXG and a Cloud Key can be chosen', () => {
    const found = findRoles(lines(['ap', 2]), w.rows, w.map)
    const split = found.all.filter((o) => o.split).map((o) => o.rows.map((r) => r.product.slug).join(' + '))
    expect(split).toContain('uxg-lite + cloud-key')
    expect(found.options.find((o) => o.label === 'Cheapest as separate products')?.rows.map((r) => r.product.slug)).toEqual(['uxg-lite', 'cloud-key'])
  })

  it('warns when more than one thing runs UniFi Network, whatever it is', () => {
    const many = (l: DerivedLine[], h: Parameters<typeof planChecks>[1] = {}) => hostedBy(l, h)['role-network-many']
    expect(many(lines(['ap', 1], ['ucg-ultra', 1]))).toBeUndefined()
    expect(many(lines(['ap', 1], ['ucg-ultra', 1], ['cloud-key', 1]))).toMatchObject({ verdict: 'warn', text: expect.stringContaining('2 things in the plan run UniFi Network (ucg-ultra, cloud-key)') })
    expect(many(lines(['ap', 1], ['ucg-ultra', 2]))).toMatchObject({ verdict: 'warn', text: expect.stringContaining('2 × ucg-ultra') })
    expect(many(lines(['ap', 1], ['ucg-ultra', 1]), { network: 'self' })).toMatchObject({ text: expect.stringContaining('a self-hosted controller') })
    expect(many(lines(['ap', 1], ['uxg-lite', 1], ['cloud-key', 1]))).toBeUndefined() // a gateway that runs nothing doesn't count
  })
})

describe('gateways filed as accessories, and Official UniFi Hosting', () => {
  const ids = [{ name: 'ids_ips_throughput_mbps', value: 1000, unit: 'Mbps', at_least: false, raw: '' }]
  const x = world([
    { slug: 'ap', type: 'WiFi' },
    { slug: 'uxg-lite', type: 'Accessories', category: 'accessories-advanced-hosting', cents: 6900, d: { metrics: ids } },
    { slug: 'cloud-key', type: 'Accessories', category: 'accessories-advanced-hosting', cents: 499900, d: { metrics: [...app('network'), { name: 'managed_devices', value: 1000, unit: 'devices', at_least: false, raw: '' }] } },
    { slug: 'unifi-hosting', type: 'Accessories', category: 'accessories-advanced-hosting', cents: 2900, d: { ports: [], known: { ...known, ports: false } } },
    { slug: 'ucg-ultra', type: 'Gateways', cents: 12900, d: { metrics: [...app('network'), { name: 'managed_devices', value: 30, unit: 'devices', at_least: true, raw: '' }, ...ids] } },
  ])

  it('treats a UXG as a gateway although the store files it as an accessory', () => {
    const c = roleChecks(x.plan(['ap', 1], ['uxg-lite', 1]))
    expect(c['role-gateway']).toMatchObject({ verdict: 'ok', text: expect.stringContaining('uxg-lite (1 Gbps IDS/IPS) is the gateway') })
    expect(c['role-network']).toMatchObject({ verdict: 'warn', roleShortfall: 'network' })
  })

  it('treats Official UniFi Hosting as a Network controller for up to 1,000 devices, with no specifications of its own', () => {
    const c = Object.fromEntries(planChecks(x.plan(['ap', 3], ['uxg-lite', 1], ['unifi-hosting', 1])).map((p) => [p.id, p]))
    expect(c['role-network']).toMatchObject({ verdict: 'ok', text: 'unifi-hosting runs UniFi Network.' })
    expect(c['role-network-capacity']).toMatchObject({ verdict: 'ok', text: '4 UniFi devices in the plan; unifi-hosting manages 1,000.' })
    expect(c['role-access']).toBeUndefined()
  })

  it('offers a UXG and hosting or a Cloud Key as separate products alongside the consoles that do both', () => {
    const found = findRoles(x.plan(['ap', 2]), x.rows, x.map)
    const labels = found.options.map((o) => `${o.label}: ${o.rows.map((r) => r.product.slug).join(' + ')}`)
    expect(labels[0]).toBe('Cheapest that fits: ucg-ultra')
    expect(labels).toContain('Cheapest as separate products: uxg-lite + unifi-hosting')
    expect(found.all.filter((o) => o.split).map((o) => o.rows.map((r) => r.product.slug).join(' + '))).toEqual(['uxg-lite + unifi-hosting', 'uxg-lite + cloud-key'])
  })

  it('offers only the Network controller to be hosted (cloud hosting is a product), and hosting is the cheapest when that is all that is missing', () => {
    const found = findRoles(x.plan(['ap', 2], ['uxg-lite', 1]), x.rows, x.map)
    expect(found.options[0]).toMatchObject({ label: 'Cheapest that fits', rows: [expect.objectContaining({ product: expect.objectContaining({ slug: 'unifi-hosting' }) })] })
  })
})
