import { overall, planChecks, type DerivedLine, type PlanCheck } from './planChecks'
import { viewLine, type PlanLine } from './plan'
import { derived, port, product } from '../test/fixtures'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
const metric = (name: string, value: number) => ({ name, value, unit: 'W', at_least: false, raw: '' })

const item = (slug: string, qty: number, d: Parameters<typeof derived>[0] | null): DerivedLine => {
  const l: PlanLine = { ref: `us/${slug}`, sku: 'SKU-1', qty, addedCents: null }
  return { view: viewLine(l, new Map([[l.ref, product({ slug, title: slug })]])), derived: d === null ? null : derived({ slug, known, ...d }) }
}

const poeIn = port({ count: 1, poe_class: 'PoE+', poe_direction: 'in' })
const poeOut = (n: number, cls = 'PoE+') => port({ count: n, poe_class: cls, poe_direction: 'out' })
const src = (kind: 'poe' | 'ac' | 'dc' | 'usb' | 'passive_poe', poe_class = '') => ({ kind, poe_class, detail: poe_class || kind })
const ap = (qty: number, draw: number | null = 13) => item('ap', qty, { ports: [poeIn], metrics: draw === null ? [] : [metric('power_draw_max_w', draw)] })
const sw = (qty: number, budget: number | null, ports = 8) => item('sw', qty, { ports: [poeOut(ports)], metrics: budget === null ? [] : [metric('poe_budget_w', budget)] })
const byId = (lines: DerivedLine[]) => Object.fromEntries(planChecks(lines).map((c) => [c.id, c]))

describe('planChecks', () => {
  it('says the devices fit, with the numbers', () => {
    const c = byId([ap(4), sw(1, 100)])
    expect(c['poe-power']).toMatchObject({ verdict: 'ok', text: 'Devices draw up to 52 W of the 100 W supplied.' })
    expect(c['poe-ports']).toMatchObject({ verdict: 'ok', text: '4 PoE+ devices for 8 PoE+ ports.' })
  })

  it('multiplies by quantity on both sides', () => {
    const c = byId([ap(10, 13), sw(2, 60, 4)])
    expect(c['poe-power']).toMatchObject({ verdict: 'bad', text: 'Devices can draw up to 130 W, over the 120 W the plan supplies.' })
    expect(c['poe-ports']).toMatchObject({ verdict: 'bad', text: expect.stringContaining('10 PoE+ devices for 8 PoE+ ports') })
  })

  it('says it can’t tell rather than guess when a draw or a budget is missing', () => {
    expect(byId([ap(2, null), sw(1, 100)])['poe-power']).toMatchObject({ verdict: 'unknown', text: expect.stringContaining("no power draw is known for ap") })
    expect(byId([ap(2), sw(1, null)])['poe-power']).toMatchObject({ verdict: 'unknown', text: expect.stringContaining('no PoE budget is known for sw') })
  })

  it('still calls known demand over known supply bad, whatever else is unknown', () => {
    expect(byId([ap(10, 13), ap(1, null), sw(1, 100)])['poe-power']?.verdict).toBe('bad') // 130 W drawn vs 100 W, plus one unknown
  })

  it('reports a lone side as information, not a failure (the other half may already be owned)', () => {
    expect(byId([ap(3)])['poe-power']).toMatchObject({ verdict: 'info', text: expect.stringContaining('nothing in the plan supplies PoE') })
    expect(byId([sw(1, 100)])['poe-power']).toMatchObject({ verdict: 'info', text: expect.stringContaining('no PoE-powered device') })
    expect(byId([ap(3)])['poe-ports']).toBeUndefined()
  })

  it('finds a PoE-powered device from its Power Method when its ports say nothing about PoE (an access point like the E7)', () => {
    const e7 = item('e7', 6, { ports: [port({ count: 1, max_speed_mbps: 10000 })], metrics: [metric('power_draw_max_w', 43)], power: [src('poe', 'PoE++')], known: { ...known, poe: false } })
    const c = byId([e7, sw(1, 155, 8)])
    // The switch's ports are PoE+ in this test, too low for a PoE++ device.
    expect(c['poe-power']).toMatchObject({ verdict: 'bad', text: 'Devices can draw up to 258 W, over the 155 W the plan supplies.' })
    expect(c['poe-ports']).toMatchObject({ verdict: 'bad', text: expect.stringContaining("6 PoE++ devices for 8 PoE+ ports: 6 can't be given a port of a high enough class") })
    const fits = byId([e7, item('swpp', 1, { ports: [poeOut(8, 'PoE++')], metrics: [metric('poe_budget_w', 400)] })])
    expect(fits['poe-ports']).toMatchObject({ verdict: 'ok', text: '6 PoE++ devices for 8 PoE++ ports.' })
    expect(fits['poe-power']).toMatchObject({ verdict: 'ok' })
  })

  it('does not count a device that can also run on something else, such as an AC adapter', () => {
    const either = item('either', 4, { ports: [port()], metrics: [metric('power_draw_max_w', 20)], power: [src('poe', 'PoE+'), src('ac')] })
    expect(byId([either, sw(1, 100)])['poe-ports']).toBeUndefined()
    expect(byId([either, sw(1, 100)])['poe-power']).toMatchObject({ verdict: 'info', text: expect.stringContaining('no PoE-powered device') })
  })

  it('says which class of port the switch has, mixed classes highest first', () => {
    const mixed = item('mixed', 1, { ports: [poeOut(8, 'PoE+'), poeOut(16, 'PoE++')], metrics: [metric('poe_budget_w', 400)] })
    expect(byId([mixed])['poe-power']?.text).toBe('400 W of PoE budget and 16 PoE++ and 8 PoE+ ports, and no PoE-powered device in the plan yet.')
  })

  it('gives each device the lowest class of port that will do, so high-class ports are left for the devices that need them', () => {
    const lowDevices = item('low', 4, { ports: [port()], metrics: [metric('power_draw_max_w', 10)], power: [src('poe', 'PoE')] })
    const highDevices = item('high', 4, { ports: [port()], metrics: [metric('power_draw_max_w', 10)], power: [src('poe', 'PoE++')] })
    const switches = item('s', 1, { ports: [poeOut(4, 'PoE'), poeOut(4, 'PoE++')], metrics: [metric('poe_budget_w', 300)] })
    expect(byId([lowDevices, highDevices, switches])['poe-ports']).toMatchObject({ verdict: 'ok', text: '4 PoE++ and 4 PoE devices for 4 PoE++ and 4 PoE ports.' })
    // Three more of the low devices would have to take PoE++ ports, leaving too few for the high ones.
    const more = item('low', 7, { ports: [port()], metrics: [metric('power_draw_max_w', 10)], power: [src('poe', 'PoE')] })
    expect(byId([more, highDevices, switches])['poe-ports']).toMatchObject({ verdict: 'bad' })
  })

  it('lets a higher class of port power a lower class of device, but not the other way round', () => {
    const device = (cls: string) => item('d', 2, { ports: [port()], metrics: [metric('power_draw_max_w', 30)], power: [src('poe', cls)] })
    const ports = (cls: string) => item('s', 1, { ports: [poeOut(8, cls)], metrics: [metric('poe_budget_w', 400)] })
    expect(byId([device('PoE++'), ports('PoE+++')])['poe-ports']).toMatchObject({ verdict: 'ok', text: '2 PoE++ devices for 8 PoE+++ ports.' })
    expect(byId([device('PoE+'), ports('PoE++')])['poe-ports']?.verdict).toBe('ok')
    expect(byId([device('PoE+++'), ports('PoE++')])['poe-ports']?.verdict).toBe('bad')
  })

  it('ignores products whose ports aren’t known, and says nothing when nothing applies', () => {
    expect(planChecks([item('mystery', 1, { known: { ...known, ports: false }, ports: [poeIn] }), item('nodata', 1, null)])).toEqual([])
  })

  it('adds up rack space, and says when a height is missing', () => {
    const rack = (slug: string, qty: number, units: number) => item(slug, qty, { rack: { mountable: true, units, full_depth: false } })
    expect(byId([rack('sw', 2, 2), rack('gw', 1, 1), item('ap', 1, { rack: { mountable: false, units: 0, full_depth: false } })]).rack).toMatchObject({ verdict: 'info', text: '5U of rack space (2 × sw 2U, gw 1U).' })
    expect(byId([rack('sw', 1, 2), rack('odd', 1, 0)]).rack).toMatchObject({ verdict: 'unknown', text: expect.stringContaining("height of odd isn't known") })
  })
  describe('rack space', () => {
    const typed = (slug: string, type: string, d: Parameters<typeof derived>[0] | null, qty = 1): DerivedLine => {
      const l: PlanLine = { ref: `us/${slug}`, sku: 'S', qty, addedCents: null }
      return { view: viewLine(l, new Map([[l.ref, product({ slug, title: slug, type })]])), derived: d === null ? null : derived({ slug, known, ...d }) }
    }
    // A product by its real slug and title, as the store has it (the rack mounts are matched by slug).
    const real = (slug: string, title: string, type: string, category: string, d: Parameters<typeof derived>[0] | null, qty = 1): DerivedLine => {
      const l: PlanLine = { ref: `us/${slug}`, sku: 'S', qty, addedCents: null }
      return { view: viewLine(l, new Map([[l.ref, product({ slug, title, type, category })]])), derived: d === null ? null : derived({ slug, known, ...d }) }
    }
    const deskDevice = { rack: { mountable: false, units: 0, full_depth: false } }
    const racked = (slug: string, units: number) => typed(slug, 'Switches', { rack: { mountable: true, units, full_depth: false } })
    const desk = (slug: string, type = 'Switches') => typed(slug, type, { rack: { mountable: false, units: 0, full_depth: false } })

    it('says which equipment is not rack-mount, and needs a shelf', () => {
      expect(byId([racked('sw', 1), desk('xg8')]).rack).toMatchObject({ verdict: 'info', text: '1U of rack space (sw 1U). Not rack-mount, so it needs a shelf or desk space: xg8.' })
    })

    it('names the Instant and the CloudKey+, recorders and consoles filed with the cameras, as needing a shelf', () => {
      const instant = real('unvr-instant', 'UNVR Instant', 'Cameras & Security', 'physical-security-nvr', deskDevice)
      const key = real('uck-g2-ssd', 'CloudKey+', 'Cameras & Security', 'physical-security-nvr', deskDevice)
      expect(byId([racked('sw', 1), instant, key]).rack?.text).toBe('1U of rack space (sw 1U). Not rack-mount, so it needs a shelf or desk space: UNVR Instant, CloudKey+.')
    })

    it('counts a PDU Pro and a patch panel, whose height the store does not give, and lays the check out as lists', () => {
      const none = { rack: { mountable: false, units: 0, full_depth: false } }
      const c = byId([racked('sw', 1), real('usp-pdu-pro', 'PDU Pro', 'Integrations', 'integrations-power-tech', none), real('uacc-rack-panel-patch-blank-24', 'Patch Panel', 'Accessories', 'accessories-rack-mount', none), desk('xg8')]).rack
      expect(c?.text).toBe('4U of rack space (sw 1U, PDU Pro 2U, Patch Panel 1U). Not rack-mount, so it needs a shelf or desk space: xg8.')
      expect(c?.groups).toEqual([
        { text: '4U of rack space', ordered: true, items: ['sw 1U', 'PDU Pro 2U', 'Patch Panel 1U'] },
        { text: 'Not rack-mount, so it needs a shelf or desk space:', items: ['xg8'] },
      ])
    })

    describe('rack-mount accessories', () => {
      const mountOf = (slug: string, title: string, qty = 1) => real(slug, title, 'Accessories', 'accessories-rack-mount', { rack: { mountable: false, units: 0, full_depth: false } }, qty)
      const aiKey = (qty: number) => real('ai-key', 'AI Key', 'Cameras & Security', 'physical-security-nvr', deskDevice, qty)

      it('counts the accessory in the rack space and takes what it holds off the shelf list', () => {
        const c = byId([aiKey(3), mountOf('uacc-ai-key-rm', 'AI Key Rack Mount')]).rack
        expect(c).toMatchObject({ verdict: 'info', text: '1U of rack space (AI Key Rack Mount 1U).' })
      })

      it('leaves on the shelf list the ones the accessories do not have room for', () => {
        expect(byId([aiKey(4), mountOf('uacc-ai-key-rm', 'AI Key Rack Mount')]).rack?.text).toBe('1U of rack space (AI Key Rack Mount 1U). Not rack-mount, so it needs a shelf or desk space: AI Key (1 of 4).')
        expect(byId([aiKey(4), mountOf('uacc-ai-key-rm', 'AI Key Rack Mount', 2)]).rack?.text).toBe('2U of rack space (2 × AI Key Rack Mount 1U).')
      })

      it('holds six AI Ports, three AI Keys and one of the rest', () => {
        const port6 = real('up-ai-port', 'AI Port', 'Cameras & Security', 'physical-security-nvr', deskDevice, 6)
        expect(byId([port6, mountOf('uacc-ai-port-rm', 'AI Port Rack Mount')]).rack?.text).toBe('1U of rack space (AI Port Rack Mount 1U).')
        expect(byId([real('up-ai-port', 'AI Port', 'Cameras & Security', 'physical-security-nvr', deskDevice, 7), mountOf('uacc-ai-port-rm', 'AI Port Rack Mount')]).rack?.text).toContain('AI Port (1 of 7)')
        const key = real('uck-g2-ssd', 'CloudKey+', 'Cameras & Security', 'physical-security-nvr', deskDevice, 2)
        expect(byId([key, mountOf('ckg2-rack-mount', 'CloudKey Rack Mount')]).rack?.text).toContain('CloudKey+ (1 of 2)')
      })

      it('puts a device that is rack-mount only with its accessory (a Pro Max 16 or the Industrial gateway) on the shelf list without one', () => {
        const pm = real('usw-pro-max-16', 'Pro Max 16', 'Switches', 'switching-professional-max-xg', { rack: { mountable: true, units: 1, full_depth: false } })
        expect(byId([pm]).rack?.text).toBe('Nothing in the plan goes in a rack. Not rack-mount, so it needs a shelf or desk space: Pro Max 16.')
        expect(byId([pm, mountOf('uacc-pro-max-16-rm', 'Pro Max 16 Rack Mount')]).rack?.text).toBe('1U of rack space (Pro Max 16 Rack Mount 1U).')
        const ind = real('ucg-industrial', 'Industrial', 'Gateways', 'cloud-gateways-wifi-integrated', { rack: { mountable: true, units: 0, full_depth: false } })
        expect(byId([ind, mountOf('uacc-ucg-industrial-rm', 'Industrial Rack Mount')]).rack?.text).toBe('1U of rack space (Industrial Rack Mount 1U).')
      })

      it('shares one accessory between the models it fits', () => {
        const a = real('usw-pro-max-16', 'Pro Max 16', 'Switches', 'x', { rack: { mountable: true, units: 1, full_depth: false } })
        const b = real('usw-pro-max-16-poe', 'Pro Max 16 PoE', 'Switches', 'x', { rack: { mountable: true, units: 1, full_depth: false } })
        expect(byId([a, b, mountOf('uacc-pro-max-16-rm', 'Pro Max 16 Rack Mount')]).rack?.text).toContain('Pro Max 16 PoE')
        expect(byId([a, b, mountOf('uacc-pro-max-16-rm', 'Pro Max 16 Rack Mount', 2)]).rack?.text).toBe('2U of rack space (2 × Pro Max 16 Rack Mount 1U).')
      })

      it('still counts an accessory that has nothing to hold', () => {
        expect(byId([mountOf('uacc-ai-key-rm', 'AI Key Rack Mount')]).rack?.text).toBe('1U of rack space (AI Key Rack Mount 1U).')
      })
    })

    it('mentions desktop equipment even when nothing else is racked', () => {
      expect(byId([desk('xg8')]).rack).toMatchObject({ verdict: 'info', text: 'Nothing in the plan goes in a rack. Not rack-mount, so it needs a shelf or desk space: xg8.' })
    })

    it('leaves out things that never go in a rack', () => {
      expect(byId([racked('sw', 1), desk('ap', 'WiFi'), desk('cam', 'Cameras & Security')]).rack?.text).toBe('1U of rack space (sw 1U).')
      expect(byId([desk('ap', 'WiFi')]).rack).toBeUndefined()
    })

    it('says it can’t tell, rather than leaving out, when a rackable product’s mounting is unknown', () => {
      const unknownRack = typed('odd', 'Switches', { known: { ...known, rack: false } })
      expect(byId([racked('sw', 1), unknownRack]).rack).toMatchObject({ verdict: 'unknown', text: '1U of rack space (sw 1U). Can\'t tell whether odd is rack-mount.' })
      expect(byId([racked('sw', 1), typed('nodata', 'Gateways', null)]).rack).toMatchObject({ verdict: 'unknown', text: expect.stringContaining('whether nodata is rack-mount') })
      expect(byId([typed('ap', 'WiFi', { known: { ...known, rack: false } })]).rack).toBeUndefined()
    })
  })

  describe('dividing devices among switches', () => {
    const e7 = (qty: number) => item('e7', qty, { ports: [port({ count: 1, max_speed_mbps: 10000 })], metrics: [metric('power_draw_max_w', 43)], power: [src('poe', 'PoE++')], known: { ...known, poe: false } })
    const xg = item('xg', 1, { ports: [port({ count: 10, max_speed_mbps: 10000, poe_class: 'PoE+++', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 400)] })
    const hd = item('hd', 1, { ports: [port({ count: 24, max_speed_mbps: 10000, poe_class: 'PoE++', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 600)] })

    it('puts the load where the budget is, instead of filling the first switch', () => {
      const c = byId([e7(12), xg, hd])
      expect(c['poe-power']?.verdict).toBe('ok')
      expect(c['poe-layout']).toMatchObject({ verdict: 'info' })
    })

    it('says so when the total budget is enough but no division of the devices is', () => {
      const small = item('small', 1, { ports: [port({ count: 24, max_speed_mbps: 10000, poe_class: 'PoE+++', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 100)] })
      const other = item('other', 1, { ports: [port({ count: 24, max_speed_mbps: 10000, poe_class: 'PoE+++', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 100)] })
      const big = item('big', 1, { ports: [port({ count: 1, max_speed_mbps: 10000 })], metrics: [metric('power_draw_max_w', 150)], power: [src('poe', 'PoE++')], known: { ...known, poe: false } })
      const c = byId([big, small, other]) // 200 W supplied, 150 W drawn, but no switch can carry it
      expect(c['poe-power']).toMatchObject({ verdict: 'bad', text: expect.stringContaining('each switch has its own budget') })
    })

    it('spells out which ports each device takes, how many are spare, and which run slower', () => {
      const detail = byId([e7(12), hd])['poe-layout']?.detail
      expect(detail).toHaveLength(1)
      expect(detail![0]).toMatchObject({ title: 'hd: 516 of 600 W', rows: ['24 × 10 GbE PoE++ ports: 12 × e7, 12 spare'] })
      const mixed = item('mixed', 1, { ports: [port({ count: 2, max_speed_mbps: 10000, poe_class: 'PoE++', poe_direction: 'out' }), port({ count: 4, max_speed_mbps: 2500, poe_class: 'PoE++', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 600)] })
      expect(byId([e7(3), mixed])['poe-layout']?.detail?.[0]?.rows).toEqual(['2 × 10 GbE PoE++ ports: 2 × e7', '4 × 2.5 GbE PoE++ ports: 1 × e7 (runs at 2.5 GbE), 3 spare'])
    })

    it('lists devices that fit nowhere', () => {
      const tiny = item('tiny', 1, { ports: [port({ count: 24, max_speed_mbps: 10000, poe_class: 'PoE+++', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 100)] })
      const detail = byId([e7(3), tiny])['poe-layout']?.detail
      expect(detail?.at(-1)).toEqual({ title: 'No port or power left for', rows: ['1 × e7'] })
    })
  })

  describe('shortfalls', () => {
    it('flags a shortfall for power, ports, speed, and a PoE switch that is out of stock', () => {
      expect(planChecks([ap(10, 13), sw(1, 100)]).some((c) => c.shortfall)).toBe(true)
      expect(planChecks([ap(3)]).some((c) => c.shortfall)).toBe(true) // nothing supplies PoE
      expect(planChecks([ap(4), sw(1, 100)]).some((c) => c.shortfall)).toBe(false)
      const gone = item('gone', 1, { ports: [poeOut(8)], metrics: [metric('poe_budget_w', 100)] })
      gone.view = { ...gone.view, state: 'out' }
      const c = byId([ap(2), gone])
      expect(c['poe-stock']).toMatchObject({ verdict: 'warn', shortfall: true, text: expect.stringContaining("gone isn't in stock") })
    })
  })

  describe('port speed', () => {
    const e7 = (qty: number, speed = 10000) => item('e7', qty, { ports: [port({ count: 1, max_speed_mbps: speed })], metrics: [metric('power_draw_max_w', 43)], power: [src('poe', 'PoE++')], known: { ...known, poe: false } })
    const hd = (qty = 1) => item('hd', qty, {
      ports: [port({ count: 2, max_speed_mbps: 10000, poe_class: 'PoE++', poe_direction: 'out' }), port({ count: 22, max_speed_mbps: 2500, poe_class: 'PoE++', poe_direction: 'out' })],
      metrics: [metric('poe_budget_w', 600)],
    })

    it('warns when devices have a faster port than the switch can give them, and says how many and at what speed', () => {
      const c = byId([e7(10), hd()])
      expect(c['poe-ports']?.verdict).toBe('ok')
      expect(c['poe-speed']).toMatchObject({ verdict: 'warn', text: expect.stringContaining('8 of 10 e7 (10 GbE port) would run at 2.5 GbE') })
    })

    it('says nothing when every device gets a port as fast as its own', () => {
      expect(byId([e7(2), hd()])['poe-speed']).toBeUndefined()
      expect(byId([e7(10, 2500), hd()])['poe-speed']).toBeUndefined()
    })

    it('gives the fast ports to the fast devices', () => {
      const fast = e7(1)
      const slow = item('slow', 20, { ports: [port({ count: 1, max_speed_mbps: 2500 })], metrics: [metric('power_draw_max_w', 10)], power: [src('poe', 'PoE++')], known: { ...known, poe: false } })
      expect(byId([slow, fast, hd()])['poe-speed']).toBeUndefined() // one 10G port for the one device that wants it
    })

    it('does not guess when a speed is unknown, on either side', () => {
      expect(byId([e7(10, 0), hd()])['poe-speed']).toBeUndefined()
      const unsure = item('hd', 1, { ports: [port({ count: 24, max_speed_mbps: 0, poe_class: 'PoE++', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 600)] })
      expect(byId([e7(10), unsure])['poe-speed']).toBeUndefined()
    })

    it('leaves it to the ports check when the devices cannot all be powered', () => {
      const weak = item('weak', 1, { ports: [port({ count: 24, max_speed_mbps: 1000, poe_class: 'PoE+', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 600)] })
      const c = byId([e7(4), weak])
      expect(c['poe-ports']?.verdict).toBe('bad')
      expect(c['poe-speed']).toBeUndefined()
    })

    it('uses the PoE-in port’s speed when the store marks one', () => {
      const cam = item('cam', 3, { ports: [port({ count: 1, max_speed_mbps: 10000, poe_class: 'PoE+', poe_direction: 'in' })], metrics: [metric('power_draw_max_w', 10)] })
      expect(byId([cam, sw(1, 100)])['poe-speed']).toMatchObject({ verdict: 'warn', text: expect.stringContaining('all 3 cam (10 GbE port) would run at 1 GbE') })
    })
  })
})

describe('the overall answer', () => {
  const c = (verdict: PlanCheck['verdict']): PlanCheck => ({ id: verdict, label: verdict, verdict, text: '' })
  it('is yes when all pass, mostly with warnings or unknowns, no with a problem, and nothing for notes alone', () => {
    expect(overall([c('ok'), c('info')])).toMatchObject({ word: 'Yes!', emoji: '🎉' })
    expect(overall([c('ok'), c('warn')])).toMatchObject({ word: 'Mostly', emoji: '👍' })
    expect(overall([c('ok'), c('unknown')])).toMatchObject({ word: 'Mostly' })
    expect(overall([c('warn'), c('bad')])).toMatchObject({ word: 'No.', emoji: '❌' })
    expect(overall([c('info')])).toBeNull()
    expect(overall([])).toBeNull()
  })
})
