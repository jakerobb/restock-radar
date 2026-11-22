import { planChecks, type DerivedLine } from './planChecks'
import { viewLine, type PlanLine } from './plan'
import { derived, port, product } from '../test/fixtures'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }

const item = (slug: string, qty: number, type: string, d: Parameters<typeof derived>[0]): DerivedLine => {
  const l: PlanLine = { ref: `us/${slug}`, sku: 'SKU-1', qty, addedCents: null }
  return { view: viewLine(l, new Map([[l.ref, product({ slug, title: slug, type })]])), derived: derived({ slug, known, ...d }) }
}
const metric = (name: string, value: number) => ({ name, value, unit: 'W', at_least: false, raw: '' })
type P = Parameters<typeof port>[0]
const sfp = (count: number, extra: P = {}): P => ({ count, media: 'sfp+', max_speed_mbps: 10000, ...extra })

// An NVR like the UNVR: a 10G SFP+ and a 1G copper port.
const nvr = (qty = 1) => item('nvr', qty, 'Storage', { ports: [port({ media: 'sfp+', max_speed_mbps: 10000 }), port({ max_speed_mbps: 1000 })] })
const copperOnly = (qty: number) => item('key', qty, 'Storage', { ports: [port({ max_speed_mbps: 1000 })] })
const sfpOnly = (qty: number) => item('fiber', qty, 'Storage', { ports: [port({ media: 'sfp+', max_speed_mbps: 10000 })] })
const sw = (ports: P[], slug = 'sw', qty = 1) => item(slug, qty, 'Switches', { ports: ports.map((p) => port(p)) })
const gw = (ports: P[]) => item('gw', 1, 'Gateways', { ports: ports.map((p) => port(p)) })
const camera = (qty: number) => item('cam', qty, 'Cameras', { ports: [port({ poe_class: 'PoE', poe_direction: 'in' })], metrics: [metric('power_draw_max_w', 5)] })
const poeSwitch = (ports: P[]) => item('psw', 1, 'Switches', { ports: ports.map((p) => port(p)), metrics: [metric('poe_budget_w', 200)] })
const poeOut = (count: number): P => ({ count, poe_class: 'PoE', poe_direction: 'out', max_speed_mbps: 1000 })
const net = (lines: DerivedLine[]) => planChecks(lines).find((c) => c.id === 'net-ports')
const sfpCheck = (lines: DerivedLine[]) => planChecks(lines).find((c) => c.id === 'net-sfp')
const rows = (lines: DerivedLine[], title: string) => net(lines)?.detail?.find((b) => b.title === title)?.rows

describe('switch ports: devices that aren’t PoE-powered, and the switches’ uplinks', () => {
  it('says nothing when there is no device and no switch', () => {
    expect(net([camera(2)])).toBeUndefined()
    expect(planChecks([gw([{ count: 4 }])]).find((c) => c.id.startsWith('net'))).toBeUndefined()
  })

  it('reports a lone device as information with a shortfall (the switch may already be owned)', () => {
    expect(net([nvr()])).toMatchObject({ verdict: 'info', shortfall: true, text: expect.stringContaining('nothing in the plan provides switch ports') })
  })

  it('has every switch take a port for its uplink; the root of a plan with no gateway goes to the network outside it', () => {
    const c = net([sw([{ count: 8 }])])
    expect(c).toMatchObject({ verdict: 'ok', net: { unplaced: 0, spare: 7 } })
    expect(c?.text).toBe('1 switch uplink needs a port; 7 ports are spare after the PoE-powered devices.')
  })

  it('gives each device a port and says how many are spare', () => {
    const c = net([copperOnly(3), sw([{ count: 8 }])])
    expect(c).toMatchObject({ verdict: 'ok', net: { unplaced: 0, spare: 4 } })
    expect(c?.text).toBe('3 devices (key) and 1 switch uplink need a port; 4 ports are spare after the PoE-powered devices.')
  })

  it('is bad when the switch has too few ports (its uplink takes one), and offers the shortfall', () => {
    expect(net([copperOnly(3), sw([{ count: 3 }])])).toMatchObject({ verdict: 'bad', shortfall: true, net: { unplaced: 1, spare: 0 } })
  })

  it('counts SFP-style ports, which take an SFP device directly', () => {
    expect(net([sfpOnly(2), sw([sfp(3)])])).toMatchObject({ verdict: 'ok', net: { spare: 0 } })
  })

  it('does not put an SFP-only device on a copper port', () => {
    expect(net([sfpOnly(1), sw([{ count: 8 }])])).toMatchObject({ verdict: 'bad', text: expect.stringContaining('fiber needs an SFP-style port') })
  })

  it('lets a copper device use an SFP cage through a module, only when no copper port is left', () => {
    const lines = (n: number) => [copperOnly(n), sw([{ count: 2 }, sfp(2)])]
    // The uplink takes a cage; three devices then have two copper ports and the other cage.
    const c = net(lines(3))
    expect(c).toMatchObject({ verdict: 'ok', text: expect.stringContaining('1 link goes through an SFP module') })
    expect(rows(lines(3), 'sw')?.join('\n')).toContain('needs an SFP module')
    expect(net(lines(2))?.text).not.toContain('module')
  })

  it('puts a device with both kinds of port in a cage, and the switch’s own uplink in the other', () => {
    const lines = [nvr(), sw([{ count: 4, max_speed_mbps: 1000 }, sfp(2)])]
    expect(rows(lines, 'sw')).toEqual(['10 GbE SFP+ ports: 1 × nvr'])
    expect(rows(lines, 'Uplinks')).toEqual(['sw → the network outside the plan (root): 10 GbE SFP+ port'])
    expect(net(lines)).toMatchObject({ net: { spare: 4 } })
  })

  it('puts a device on the root switch rather than a downstream one when both have an equally good free port, whatever order the lines are in', () => {
    // The root has four cages and the other switch two: the gateway and the other switch take one of the root's, so both switches have a cage left.
    const root = sw([{ count: 4, max_speed_mbps: 1000 }, sfp(4)], 'root')
    const leaf = sw([{ count: 4, max_speed_mbps: 1000 }, sfp(2)], 'leaf')
    const gateway = gw([sfp(1)])
    for (const lines of [[nvr(), leaf, root, gateway], [nvr(), root, leaf, gateway]]) {
      expect(rows(lines, 'root')).toEqual(['10 GbE SFP+ ports: 1 × nvr'])
      expect(rows(lines, 'leaf')).toBeUndefined()
    }
  })

  it('puts a device on the switch nearest the root even when a deeper one has a slower port that would do', () => {
    // The Pro HD has only 2.5G ports and the Flex, uplinked to it, has 1G ones: a gigabit device runs at full speed on either, so it goes on the nearer.
    const hd = sw([{ count: 8, max_speed_mbps: 2500 }, sfp(2)], 'hd')
    const flex = sw([{ count: 5, max_speed_mbps: 1000 }], 'flex')
    const lines = [copperOnly(2), flex, hd, gw([sfp(1)])]
    expect(rows(lines, 'flex')).toBeUndefined()
    expect(rows(lines, 'hd')).toEqual(['2.5 GbE RJ45 ports: 2 × key'])
  })

  it('takes the slowest port that gives a device its full speed among those on one switch, leaving the faster for a device that needs it', () => {
    const fast = item('fast', 1, 'Storage', { ports: [port({ max_speed_mbps: 10000 })] })
    const lines = [copperOnly(1), fast, sw([{ count: 4, max_speed_mbps: 1000 }, { count: 2, max_speed_mbps: 10000 }], 'only')]
    expect(rows(lines, 'only')).toEqual(['1 GbE RJ45 ports: 1 × key', '10 GbE RJ45 ports: 1 × fast'])
  })

  it('takes the ports PoE-powered devices are on out of what is free, and keeps uplinks off the PoE ports', () => {
    // 8 PoE ports and 2 others; 6 cameras are on PoE ports, the uplink takes a plain port, so 3 ports are left.
    const lines = (n: number) => [camera(6), copperOnly(n), poeSwitch([poeOut(8), { count: 2 }])]
    expect(net(lines(3))).toMatchObject({ verdict: 'ok', net: { spare: 0 } })
    expect(net(lines(4))).toMatchObject({ verdict: 'bad', net: { unplaced: 1 } })
  })

  it('does not charge a switch for the cameras that are on an NVR’s PoE ports', () => {
    // The recorder has three PoE ports and the switch two PoE++ ones. Cameras take the lowest class that will do, so three go on the recorder
    // and one on the switch, whose other port is the recorder's own: the cameras on the recorder must not be taken out of the switch's ports.
    const recorder = item('rec', 1, 'Storage', { ports: [port({ max_speed_mbps: 1000 }), port(poeOut(3))] })
    const lines = [camera(4), recorder, poeSwitch([{ ...poeOut(2), poe_class: 'PoE++' }, sfp(1)])]
    expect(net(lines)).toMatchObject({ verdict: 'ok', net: { unplaced: 0, spare: 0 } })
    expect(rows(lines, 'psw')).toEqual(['1 GbE RJ45 ports: 1 × rec'])
  })

  it('notices when the switch’s uplink takes a PoE port a PoE-powered device needed', () => {
    // 8 PoE ports and nothing else: 8 cameras fill them, and the uplink has no port left.
    expect(net([camera(8), poeSwitch([poeOut(8)])])).toMatchObject({ verdict: 'bad', shortfall: true, net: { unplaced: 1 }, text: expect.stringContaining('PoE-powered device') })
    expect(net([camera(7), poeSwitch([poeOut(8)])])).toMatchObject({ verdict: 'ok', net: { spare: 0 } })
  })

  it('counts a combo RJ45/SFP+ pair as one position', () => {
    const combo = [{ count: 1, max_speed_mbps: 10000, combo: true }, sfp(1, { combo: true })]
    // The uplink takes the position, so nothing is left for a device.
    expect(net([copperOnly(1), sw(combo)])).toMatchObject({ verdict: 'bad', net: { unplaced: 1 } })
    expect(net([copperOnly(1), sw([...combo, { count: 1 }])])).toMatchObject({ verdict: 'ok', net: { spare: 0 } })
  })

  it('uses a gateway’s ports for devices only when there is no switch (or the switches are full)', () => {
    expect(net([copperOnly(4), gw([{ count: 4 }])])).toMatchObject({ verdict: 'ok', net: { spare: 0 } })
    expect(net([copperOnly(5), gw([{ count: 4 }])])).toMatchObject({ verdict: 'bad' })
    const lines = [copperOnly(2), gw([{ count: 4 }]), sw([{ count: 8 }])]
    expect(rows(lines, 'sw')).toEqual(['1 GbE RJ45 ports: 2 × key'])
    expect(net(lines)).toMatchObject({ net: { spare: 8 } }) // 3 on the gateway, 5 on the switch
    expect(net([copperOnly(8), gw([{ count: 4 }]), sw([{ count: 8 }])])).toMatchObject({ verdict: 'ok' }) // 7 on the switch, one on the gateway
  })

  it('puts a device on the gateway’s faster port when that is the only way it runs at full speed, but not for the same speed', () => {
    const fast = item('fast', 1, 'Storage', { ports: [port({ max_speed_mbps: 10000 })] })
    const lines = [fast, copperOnly(1), gw([{ count: 1, max_speed_mbps: 10000 }, { count: 4 }]), sw([{ count: 8 }])]
    expect(rows(lines, 'gw')).toEqual(['10 GbE RJ45 ports: 1 × fast'])
    // The gigabit device stays on the switch; the gateway's gigabit ports are no better.
    expect(rows(lines, 'sw')).toEqual(['1 GbE RJ45 ports: 1 × key'])
  })

  it('has a switch uplink to the slowest gateway port that gives it its speed, leaving the fast one for a device', () => {
    const fast = item('fast', 1, 'Storage', { ports: [port({ max_speed_mbps: 10000 })] })
    const checks = net([fast, gw([{ count: 1, max_speed_mbps: 10000 }, { count: 1 }]), sw([{ count: 8 }])])
    expect(checks?.detail?.find((b) => b.title === 'Uplinks')?.rows).toEqual(['sw → gw (root): 1 GbE copper'])
    expect(rows([fast, gw([{ count: 1, max_speed_mbps: 10000 }, { count: 1 }]), sw([{ count: 8 }])], 'gw')).toEqual(['10 GbE RJ45 ports: 1 × fast'])
  })

  it('says it can’t tell when a switch’s ports are unknown and the known ones fall short', () => {
    const mystery = item('mystery', 1, 'Switches', { known: { ...known, ports: false }, ports: [] })
    expect(net([copperOnly(3), sw([{ count: 3 }]), mystery])).toMatchObject({ verdict: 'unknown' })
    expect(net([copperOnly(1), sw([{ count: 3 }]), mystery])).toMatchObject({ verdict: 'ok' })
  })

  describe('topology', () => {
    const agg = (cages = 8) => sw([sfp(cages)], 'agg')
    const leaf = (slug: string, cages = 2) => sw([{ count: 8 }, sfp(cages)], slug)

    it('roots the tree at the switch with the most SFP cages, which uplinks to the gateway; the others uplink to it', () => {
      const lines = [leaf('a'), leaf('b'), agg(), gw([{ count: 4 }, sfp(1)])]
      expect(rows(lines, 'Uplinks')).toEqual(['agg → gw (root): 10 GbE SFP+', 'a → agg: 10 GbE SFP+', 'b → agg: 10 GbE SFP+'])
      expect(sfpCheck(lines)).toBeUndefined()
    })

    it('prefers a cage on the gateway, and a cage for every switch that has one', () => {
      const lines = [leaf('a'), gw([{ count: 4 }, sfp(1)])]
      expect(rows(lines, 'Uplinks')).toEqual(['a → gw (root): 10 GbE SFP+'])
    })

    it('keeps the tree flat: switches go on the root while it has a port, even a copper one, and warn for want of a cage', () => {
      // The root has one free cage after the gateway; the other two leaves with cages go over copper to the root, not deeper.
      const lines = [leaf('a', 1), leaf('b', 1), leaf('c', 1), sw([{ count: 8 }, sfp(2)], 'root'), gw([{ count: 4 }, sfp(1)])]
      const w = sfpCheck(lines)
      expect(rows(lines, 'Uplinks')?.[0]).toBe('root → gw (root): 10 GbE SFP+')
      expect(rows(lines, 'Uplinks')?.filter((r) => typeof r === 'string' && r.includes('→ root'))).toHaveLength(3)
      expect(w).toMatchObject({ verdict: 'warn', shortfall: true, text: expect.stringContaining('aggregation switch') })
      expect(w?.net?.sfpMisses).toBe(2)
    })

    it('goes a level deeper only when the root is full, and warns', () => {
      const lines = [leaf('a', 1), leaf('b', 1), sw([sfp(2)], 'root'), gw([{ count: 4 }, sfp(1)])]
      // root: 2 cages, one to the gateway, one to a; b has no port on the root left, so it goes to a.
      expect(rows(lines, 'Uplinks')).toEqual(['root → gw (root): 10 GbE SFP+', 'a → root: 10 GbE SFP+', 'b → a: 1 GbE copper'])
      expect(sfpCheck(lines)?.text).toContain('b has SFP ports')
    })

    it('does not warn when the gateway has no cage for the root to use (a switch can’t fix that)', () => {
      expect(sfpCheck([agg(), gw([{ count: 4 }])])).toBeUndefined()
      expect(rows([agg(), gw([{ count: 4 }])], 'Uplinks')).toEqual(['agg → gw (root): 1 GbE copper through an SFP module'])
    })

    it('does not warn for a switch with no cages, nor when the uplink is the network outside the plan', () => {
      expect(sfpCheck([sw([{ count: 8 }, sfp(1)], 'a')])).toBeUndefined()
      expect(sfpCheck([sw([{ count: 8 }], 'plain', 1), sw([{ count: 8 }, sfp(2)], 'cages')])).toBeUndefined()
    })

    it('says a switch has no uplink when every port upstream is taken', () => {
      // No gateway: the root's only port goes outside, so the other switch has nothing to plug into.
      expect(net([sw([{ count: 1 }], 'a'), sw([{ count: 1 }], 'b')])).toMatchObject({ verdict: 'bad', shortfall: true, text: expect.stringContaining("uplink") })
    })

    it('uplinks a switch powered over PoE through its PoE-in port, which is no use to anything else', () => {
      const flex = sw([{ count: 4 }, { count: 1, poe_class: 'PoE+', poe_direction: 'in' }], 'flex')
      const lines = [flex, sw([{ count: 8 }, sfp(1)], 'root')]
      expect(rows(lines, 'Uplinks')).toEqual(['root → the network outside the plan (root): 10 GbE SFP+ port', 'flex → root: 1 GbE copper'])
      expect(net(lines)).toMatchObject({ net: { spare: 11 } }) // root: 8 copper left; flex: 4
    })

    it('counts a switch quantity as separate switches, each with an uplink', () => {
      const lines = [sw([{ count: 8 }, sfp(1)], 'pair', 2), gw([{ count: 4 }, sfp(2)])]
      // The first one's only cage goes to the gateway, so the second goes over copper (and the plan is told).
      expect(rows(lines, 'Uplinks')).toEqual(['pair #1 → gw (root): 10 GbE SFP+', 'pair #2 → pair #1: 1 GbE copper'])
      expect(sfpCheck(lines)?.text).toContain('pair #2 has SFP ports')
    })
  })
})
