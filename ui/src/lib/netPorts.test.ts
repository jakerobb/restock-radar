import { planChecks, type DerivedLine } from './planChecks'
import { viewLine, type PlanLine } from './plan'
import { derived, port, product } from '../test/fixtures'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }

const item = (slug: string, qty: number, type: string, d: Parameters<typeof derived>[0]): DerivedLine => {
  const l: PlanLine = { ref: `us/${slug}`, sku: 'SKU-1', qty, addedCents: null }
  return { view: viewLine(l, new Map([[l.ref, product({ slug, title: slug, type })]])), derived: derived({ slug, known, ...d }) }
}
const metric = (name: string, value: number) => ({ name, value, unit: 'W', at_least: false, raw: '' })

// An NVR like the UNVR: a 10G SFP+ and a 1G copper port.
const nvr = (qty = 1) => item('nvr', qty, 'Storage', { ports: [port({ media: 'sfp+', max_speed_mbps: 10000 }), port({ max_speed_mbps: 1000 })] })
const copperOnly = (qty: number) => item('key', qty, 'Gateways-ish', { ports: [port({ max_speed_mbps: 1000 })] })
const sfpOnly = (qty: number) => item('fiber', qty, 'Storage', { ports: [port({ media: 'sfp+', max_speed_mbps: 10000 })] })
const sw = (qty: number, ports: Parameters<typeof port>[0][]) => item('sw', qty, 'Switches', { ports: ports.map((p) => port(p)) })
const camera = (qty: number) => item('cam', qty, 'Cameras', { ports: [port({ poe_class: 'PoE', poe_direction: 'in' })], metrics: [metric('power_draw_max_w', 5)] })
const poeSwitch = (n: number) => item('psw', 1, 'Switches', { ports: [port({ count: n, poe_class: 'PoE', poe_direction: 'out', max_speed_mbps: 1000 })], metrics: [metric('poe_budget_w', 200)] })
const net = (lines: DerivedLine[]) => planChecks(lines).find((c) => c.id === 'net-ports')

describe('switch ports for devices that aren’t PoE-powered', () => {
  it('says nothing when no such device is in the plan, and treats a switch alone as no demand', () => {
    expect(net([sw(1, [{ count: 8 }])])).toBeUndefined()
    expect(net([camera(2), poeSwitch(8)])).toBeUndefined()
  })

  it('reports a lone device as information with a shortfall (the switch may already be owned)', () => {
    expect(net([nvr()])).toMatchObject({ verdict: 'info', shortfall: true, text: expect.stringContaining('nothing in the plan provides switch ports') })
  })

  it('gives each device a port and says how many are spare', () => {
    const c = net([copperOnly(3), sw(1, [{ count: 8 }])])
    expect(c).toMatchObject({ verdict: 'ok', net: { unplaced: 0, spare: 5 } })
    expect(c?.text).toBe('3 devices need a switch port (key); 5 ports are spare after the PoE-powered devices.')
  })

  it('is bad when the switches have too few ports, and offers the shortfall', () => {
    const c = net([copperOnly(3), sw(1, [{ count: 2 }])])
    expect(c).toMatchObject({ verdict: 'bad', shortfall: true, net: { unplaced: 1, spare: 0 } })
  })

  it('counts SFP-style ports, which take an SFP device directly', () => {
    expect(net([sfpOnly(2), sw(1, [{ count: 2, media: 'sfp+', max_speed_mbps: 10000 }])])).toMatchObject({ verdict: 'ok', net: { spare: 0 } })
  })

  it('does not put an SFP-only device on a copper port', () => {
    const c = net([sfpOnly(1), sw(1, [{ count: 8 }])])
    expect(c).toMatchObject({ verdict: 'bad', text: expect.stringContaining('fiber needs an SFP-style port') })
  })

  it('lets a copper device use an SFP cage through a module, only when no copper port is left', () => {
    const lines = [copperOnly(3), sw(1, [{ count: 2 }, { count: 1, media: 'sfp+', max_speed_mbps: 10000 }])]
    const c = net(lines)
    expect(c).toMatchObject({ verdict: 'ok', text: expect.stringContaining('1 copper device goes in an SFP port with a module') })
    expect(c?.detail?.[0]?.rows.join('\n')).toContain('needs an SFP module')
    expect(net([copperOnly(2), sw(1, [{ count: 2 }, { count: 1, media: 'sfp+', max_speed_mbps: 10000 }])])?.text).not.toContain('module')
  })

  it('puts a device with both kinds of port on the faster one', () => {
    const c = net([nvr(), sw(1, [{ count: 4, max_speed_mbps: 1000 }, { count: 2, media: 'sfp+', max_speed_mbps: 10000 }])])
    expect(c?.detail?.[0]?.rows).toEqual(['10 GbE SFP+ ports: 1 × nvr'])
    expect(c).toMatchObject({ net: { spare: 5 } })
  })

  it('takes the ports PoE-powered devices are on out of what is free', () => {
    // 8 PoE ports, 6 cameras on them, so only 2 are left for two non-PoE devices; three won't fit.
    expect(net([camera(6), copperOnly(2), poeSwitch(8)])).toMatchObject({ verdict: 'ok', net: { spare: 0 } })
    expect(net([camera(6), copperOnly(3), poeSwitch(8)])).toMatchObject({ verdict: 'bad', net: { unplaced: 1 } })
  })

  it('counts a combo RJ45/SFP+ pair as one position', () => {
    const combo = [{ count: 1, max_speed_mbps: 10000, combo: true }, { count: 1, media: 'sfp+', max_speed_mbps: 10000, combo: true }]
    expect(net([copperOnly(2), sw(1, combo)])).toMatchObject({ verdict: 'bad', net: { unplaced: 1 } })
    expect(net([sfpOnly(1), sw(1, combo)])).toMatchObject({ verdict: 'ok' })
  })

  it('counts a gateway’s LAN ports, holding one back for the internet connection', () => {
    const gw = (n: number) => item('gw', 1, 'Gateways', { ports: [port({ count: n, max_speed_mbps: 1000 })] })
    expect(net([copperOnly(4), gw(5)])).toMatchObject({ verdict: 'ok', net: { spare: 0 } })
    expect(net([copperOnly(5), gw(5)])).toMatchObject({ verdict: 'bad' })
  })

  it('says it can’t tell when a switch’s ports are unknown and the known ones fall short', () => {
    const mystery = item('mystery', 1, 'Switches', { known: { ...known, ports: false }, ports: [] })
    expect(net([copperOnly(3), sw(1, [{ count: 2 }]), mystery])).toMatchObject({ verdict: 'unknown' })
    expect(net([copperOnly(1), sw(1, [{ count: 2 }]), mystery])).toMatchObject({ verdict: 'ok' })
  })
})
