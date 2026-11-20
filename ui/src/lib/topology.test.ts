import { derived, port, product } from '../test/fixtures'
import { viewLine, type PlanLine } from './plan'
import type { DerivedLine } from './planChecks'
import { buildTopology, type TopoNode } from './topology'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
type P = Parameters<typeof port>[0]
const item = (slug: string, qty: number, type: string, d: Parameters<typeof derived>[0]): DerivedLine => {
  const l: PlanLine = { ref: `us/${slug}`, sku: 'SKU-1', qty, addedCents: null }
  return { view: viewLine(l, new Map([[l.ref, product({ slug, title: slug.toUpperCase(), type })]])), derived: derived({ slug, known, ...d }) }
}
const metric = (name: string, value: number) => ({ name, value, unit: 'W', at_least: false, raw: '' })
const gw = (n = 4) => item('gw', 1, 'Gateways', { ports: [port({ count: n, max_speed_mbps: 1000 })] })
const sw = (slug: string, ports: P[] = [{ count: 8, max_speed_mbps: 1000 }], qty = 1) => item(slug, qty, 'Switches', { ports: ports.map((p) => port(p)), metrics: [metric('poe_budget_w', 200)] })
const poeOut = (count: number): P => ({ count, poe_class: 'PoE', poe_direction: 'out', max_speed_mbps: 1000 })
const cam = (qty: number) => item('cam', qty, 'Cameras', { ports: [port({ poe_class: 'PoE', poe_direction: 'in' })], metrics: [metric('power_draw_max_w', 5)] })
const nvr = () => item('nvr', 1, 'Storage', { ports: [port({ max_speed_mbps: 1000 })] })

/** A node as text: "GW[SW[CAM × 4]]". */
const show = (n: TopoNode): string => `${n.title}${n.qty > 1 ? ` × ${n.qty}` : ''}${n.children.length > 0 ? `[${n.children.map(show).join(', ')}]` : ''}`

describe('buildTopology', () => {
  it('hangs the switch from the gateway and the devices from the switch, identical ones in one box', () => {
    const t = buildTopology([gw(), sw('sw', [{ count: 8, max_speed_mbps: 1000 }, poeOut(8)]), cam(4), nvr()])!
    expect(t.roots.map(show)).toEqual(['GW[SW[CAM × 4, NVR]]'])
    expect(t.unconnected).toEqual([])
  })

  it('puts a switch that uplinks to another under it, switches before devices', () => {
    const t = buildTopology([gw(1), sw('a', [{ count: 1, max_speed_mbps: 10000, media: 'sfp+' }, { count: 4, max_speed_mbps: 1000 }]), sw('b', [{ count: 8, max_speed_mbps: 1000 }]), nvr()])!
    expect(t.roots).toHaveLength(1)
    expect(t.roots[0]!.title).toBe('GW')
    expect(t.roots[0]!.children.length).toBeGreaterThan(0)
  })

  it('numbers the units of a line that has several', () => {
    const t = buildTopology([gw(), sw('sw', [{ count: 8, max_speed_mbps: 1000 }], 2)])!
    const titles = (n: TopoNode): string[] => [n.title, ...n.children.flatMap(titles)]
    expect(t.roots.flatMap(titles)).toEqual(expect.arrayContaining(['SW #1', 'SW #2']))
  })

  it('has the root switch at the top when there is no gateway', () => {
    const t = buildTopology([sw('sw', [{ count: 8, max_speed_mbps: 1000 }]), nvr()])!
    expect(t.roots.map(show)).toEqual(['SW[NVR]'])
  })

  it('lists devices with no port apart, as unconnected', () => {
    const t = buildTopology([gw(1), nvr(), nvr()].slice(0, 2).concat(item('nvr2', 1, 'Storage', { ports: [port({ max_speed_mbps: 1000 })] })))!
    expect(t.unconnected.map((n) => n.title)).toEqual(['NVR2'])
  })

  it('labels how each box is plugged in, and how many ports a switch has spare', () => {
    const t = buildTopology([gw(), sw('sw', [{ count: 8, max_speed_mbps: 1000 }]), nvr()])!
    const swNode = t.roots[0]!.children[0]!
    expect(t.roots[0]!.uplink).toBeUndefined()
    expect(swNode.uplink).toEqual({ label: '1GbE RJ45', slow: false })
    expect(swNode.spare).toBe(6)
    expect(swNode.children[0]!.uplink).toEqual({ label: '1GbE RJ45', slow: false })
    expect(swNode.children[0]!.spare).toBeUndefined()
  })

  it('marks an uplink slower than the device could do', () => {
    const fast: P = { count: 2, max_speed_mbps: 10000, media: 'sfp+' }
    const t = buildTopology([gw(2), sw('sw', [{ count: 8, max_speed_mbps: 1000 }, fast])])!
    const swNode = t.roots[0]!.children[0]!
    // The gateway has no cage, so the switch's 10G cage can't be used: it runs at 1 GbE.
    expect(swNode.uplink).toEqual({ label: '1GbE RJ45', slow: true })
  })

  it('is null with nothing to hang from, or with a single box', () => {
    expect(buildTopology([cam(2), nvr()])).toBeNull()
    expect(buildTopology([gw()])).toBeNull()
  })
})
