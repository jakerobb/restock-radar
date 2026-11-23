import { scenarioCode } from './powering'
import { lineKey } from './plan'
import { overall, planChecks, type DerivedLine, type PlanCheck, type Trace } from './planChecks'
import { viewLine, type PlanLine } from './plan'
import { derived, port, product, variant } from '../test/fixtures'

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
  it('calls out products with no tech specs, and says the other checks leave them out', () => {
    const c = byId([ap(2), sw(1, 100), item('newbie', 1, null), item('blank', 1, { known: { ports: false, poe: false, radios: false, rack: false, dims: false } })])
    expect(c['specs']).toMatchObject({ verdict: 'unknown', text: expect.stringContaining('No tech specs are known yet for newbie, blank') })
    expect(c['specs']!.text).toContain('left out of the checks')
  })

  it('does not call out products whose specs gave something, or say anything when all are known', () => {
    expect(byId([ap(2), sw(1, 100)])['specs']).toBeUndefined()
    expect(byId([item('rackonly', 1, { known: { ...known, ports: false, poe: false, radios: false, dims: false } })])['specs']).toBeUndefined()
  })

  it('makes the answer "Unsure" when a product has no specs, unless something is plainly wrong', () => {
    expect(overall(planChecks([ap(2), sw(1, 100), item('newbie', 1, null)]))).toMatchObject({ word: 'Unsure', emoji: '🤷🏻‍♂️', tone: 'unsure' })
    expect(overall(planChecks([ap(20, 13), sw(1, 100), item('newbie', 1, null)]))).toMatchObject({ word: 'No.' })
  })

  it('leaves a product that no specs are expected for out of the check, and says nothing when that is all there is', () => {
    const cable = { ...item('cable', 1, null), gap: 'not-expected' as const }
    expect(byId([ap(2), sw(1, 100), cable])['specs']).toBeUndefined()
    expect(overall(planChecks([ap(2), sw(1, 100), cable]))).toEqual(overall(planChecks([ap(2), sw(1, 100)]))) // as if it weren't there
    expect(byId([ap(2), sw(1, 100), cable, item('newbie', 1, null)])['specs']!.text).toContain('for newbie,')
  })

  it('says whether a product has yet to be read from the store or the store publishes none', () => {
    const c = byId([{ ...item('soon', 1, null), gap: 'pending' as const }, { ...item('bare', 1, null), gap: 'none' as const }])['specs']!
    expect(c.text).toContain("soon hasn't been read from the store yet")
    expect(c.text).toContain('the store publishes none for bare')
    expect(byId([{ ...item('panels', 1, null), gap: 'unusable' as const }])['specs']!.text).toContain('what the store publishes for panels gives nothing to check with')
  })

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

  it('calls PoE-powered devices with nothing to supply PoE bad, and a lone supplier information', () => {
    expect(byId([ap(3)])['poe-power']).toMatchObject({ verdict: 'bad', shortfall: true, text: expect.stringContaining('nothing in the plan supplies PoE') })
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
    // Only the note about the product with no specs at all; nothing from the PoE or port checks.
    expect(planChecks([item('mystery', 1, { known: { ...known, ports: false }, ports: [poeIn] }), item('nodata', 1, null)]).map((c) => c.id)).toEqual(['specs'])
  })

  it('counts the AC outlets: mains-powered devices that aren’t on PoE', () => {
    const mains = (slug: string, qty: number) => item(slug, qty, { power: [src('ac')] })
    expect(byId([mains('gw', 1), mains('nvr', 2), ap(3), sw(1, 100)]).outlets).toMatchObject({ verdict: 'info', text: '3 AC outlets (gw, 2 × nvr).' })
    expect(byId([mains('gw', 1)]).outlets).toMatchObject({ text: '1 AC outlet (gw).' })
    // PoE-powered devices need none, and nothing is said when no device is on the mains.
    expect(byId([ap(3), sw(1, 100)]).outlets).toBeUndefined()
    expect(byId([item('cam', 1, { power: [src('ac'), src('poe', 'PoE')], ports: [poeIn] })]).outlets).toBeUndefined()
  })

  it('plugs devices into PDU and UPS sockets, and counts only the wall outlets left', () => {
    const mains = (slug: string, qty: number) => item(slug, qty, { power: [src('ac')] })
    // UPS -> PDU -> everything: the UPS takes the one wall outlet.
    expect(byId([item('ups-tower-us', 1, null), item('usp-pdu-pro', 1, null), mains('gw', 1), mains('nvr', 2)]).outlets).toMatchObject({
      text: '1 AC outlet (ups-tower-us). 3 of 16 PDU sockets used, 1 of 8 UPS sockets used.',
    })
    // A PDU alone takes a wall outlet; what it can't hold goes to the wall too.
    expect(byId([item('usp-pdu-pro', 1, null), mains('gw', 17)]).outlets?.text).toBe('2 AC outlets (usp-pdu-pro, gw). 16 of 16 PDU sockets used.')
    // Overflow from the PDU goes to the UPS, after the PDU has taken its own socket.
    expect(byId([item('ups-2u', 1, null), item('usp-pdu-pro', 1, null), mains('gw', 20)]).outlets?.text).toBe('1 AC outlet (ups-2u). 16 of 16 PDU sockets used, 5 of 8 UPS sockets used.')
    // A UPS with no PDU powers devices directly.
    expect(byId([item('ups-tower', 1, null), mains('gw', 2)]).outlets?.text).toBe('1 AC outlet (ups-tower). 2 of 8 UPS sockets used.')
  })

  it('lays the outlets out as a tree: each UPS and PDU with what is plugged into it, then what is left for the wall', () => {
    const mains = (slug: string, qty: number) => item(slug, qty, { power: [src('ac')] })
    const tree = byId([item('ups-2u', 1, null), item('ups-tower', 1, null), item('usp-pdu-pro', 1, null), mains('gw', 1), mains('nvr', 2)]).outlets?.tree
    expect(tree).toEqual({
      heading: 'Requires 2 AC outlets',
      nodes: [
        { text: 'ups-2u (1 of 8 outlets used)', children: [{ text: 'usp-pdu-pro (3 of 16 outlets used)', children: [{ text: 'gw' }, { text: '2 × nvr' }] }] },
        { text: 'ups-tower' },
      ],
    })
    // What fits nowhere is listed last, after the PDUs on the wall.
    expect(byId([item('usp-pdu-pro', 1, null), mains('gw', 17)]).outlets?.tree?.nodes).toEqual([
      { text: 'usp-pdu-pro (16 of 16 outlets used)', children: [{ text: '16 × gw' }] },
      { text: 'gw' },
    ])
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
        { text: '4U of rack space', ordered: true, items: ['sw 1U', 'PDU Pro 2U', 'PDU Pro 2U', 'Patch Panel 1U'] },
        { text: 'Not rack-mount, so it needs a shelf or desk space:', items: ['xg8'] },
      ])
    })

    it('counts a panel by the height in its SKU, and lists a device once for each rack unit', () => {
      const none = { rack: { mountable: false, units: 0, full_depth: false } }
      const panel = (sku: string, title: string, qty = 1): DerivedLine => {
        const l: PlanLine = { ref: 'us/uacc-rack-panel-ocd', sku, qty, addedCents: null }
        return { view: viewLine(l, new Map([[l.ref, product({ slug: 'uacc-rack-panel-ocd', title: 'Rack Mount OCD Panels', type: 'Accessories', category: 'accessories-rack-mount', variants: [variant({ sku, title })] })]])), derived: derived({ slug: 'uacc-rack-panel-ocd', known, ...none }) }
      }
      const c = byId([racked('sw', 1), panel('UACC-Rack-Panel-Vented-2U', '2U Vented Panel'), panel('UACC-Rack-Panel-Brush-1U', '1U Brush Panel', 2)]).rack
      expect(c?.text).toContain('5U of rack space')
      expect(c?.groups?.[0]).toEqual({ text: '5U of rack space', ordered: true, items: ['sw 1U', 'Rack Mount OCD Panels (Vented Panel) 2U', 'Rack Mount OCD Panels (Vented Panel) 2U', 'Rack Mount OCD Panels (Brush Panel) 1U', 'Rack Mount OCD Panels (Brush Panel) 1U'] })
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
      expect(detail![0]).toMatchObject({ title: 'hd: 516 of 600 W', rows: [{ text: '24 × 10 GbE PoE++ ports:', items: ['12 × e7', '12 spare'] }] })
      const mixed = item('mixed', 1, { ports: [port({ count: 2, max_speed_mbps: 10000, poe_class: 'PoE++', poe_direction: 'out' }), port({ count: 4, max_speed_mbps: 2500, poe_class: 'PoE++', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 600)] })
      expect(byId([e7(3), mixed])['poe-layout']?.detail?.[0]?.rows).toEqual([
        { text: '2 × 10 GbE PoE++ ports:', items: ['2 × e7'] },
        { text: '4 × 2.5 GbE PoE++ ports:', items: ['1 × e7 (runs at 2.5 GbE)', '3 spare'] },
      ])
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

describe('a switch that can be powered several ways', () => {
  const scenarios = [{ name: 'PoE+ input', watts: 16, selected: false }, { name: '210W AC adapter input', watts: 196, selected: true }]
  const flex = (qty = 1) => item('flex', qty, { ports: [poeOut(8, 'PoE++')], poe_budget: scenarios, power: [{ kind: 'ac', poe_class: '', detail: '(1) AC/DC adapter (Excluded)' }], metrics: [metric('poe_budget_w', 196)] })
  const adapter = (qty: number): DerivedLine => {
    const l: PlanLine = { ref: 'us/uacc-adapter-ac-210w', sku: 'A', qty, addedCents: null }
    return { view: viewLine(l, new Map([[l.ref, product({ slug: 'uacc-adapter-ac-210w', title: 'AC Adapter 210W' })]])), derived: null }
  }
  const run = (lines: DerivedLine[], code?: number) => Object.fromEntries(planChecks(lines, {}, code === undefined ? {} : { [lineKey(lines[1]!.view.line)]: code }).map((c) => [c.id, c]))

  it('can’t tell the PoE power until the way it is powered is chosen', () => {
    expect(run([ap(2), flex()])['poe-power']).toMatchObject({ verdict: 'unknown', text: expect.stringContaining("how flex is powered hasn't been chosen") })
  })

  it('counts the budget of the input chosen', () => {
    expect(run([ap(2), flex()], scenarioCode('PoE+ input'))['poe-power']).toMatchObject({ verdict: 'bad', text: 'Devices can draw up to 26 W, over the 16 W the plan supplies.' })
    expect(run([ap(2), flex(), adapter(1)], scenarioCode('210W AC adapter input'))['poe-power']).toMatchObject({ verdict: 'ok', text: 'Devices draw up to 26 W of the 196 W supplied.' })
  })

  it('wants an adapter in the plan for each switch that runs on one sold separately', () => {
    const code = scenarioCode('210W AC adapter input')
    expect(run([ap(2), flex(2), adapter(1)], code)['power-adapter']).toMatchObject({ verdict: 'warn', text: expect.stringContaining('the plan has 1 of the 2 it needs') })
    expect(run([ap(2), flex(2), adapter(2)], code)['power-adapter']).toBeUndefined()
    expect(run([ap(2), flex()], scenarioCode('PoE+ input'))['power-adapter']).toBeUndefined()
  })
})

describe('a switch powered over PoE', () => {
  const scenarios = [{ name: 'PoE++ input', watts: 46, selected: false }, { name: '210W AC adapter input', watts: 196, selected: true }]
  const flex = () => item('flex', 1, { ports: [poeOut(8, 'PoE++'), port({ count: 1, poe_class: 'PoE+++', poe_direction: 'in' })], poe_budget: scenarios, power: [{ kind: 'ac', poe_class: '', detail: '(1) AC/DC adapter (Excluded)' }], metrics: [metric('poe_budget_w', 196), metric('power_draw_excl_poe_w', 17), metric('power_draw_max_w', 210)] })
  const upstream = (budget: number) => item('up', 1, { ports: [poeOut(8, 'PoE++')], metrics: [metric('poe_budget_w', budget)] })
  const run = (lines: DerivedLine[], pick: string) => {
    const f = lines.find((l) => l.view.line.ref === 'us/flex')!
    return Object.fromEntries(planChecks(lines, {}, { [lineKey(f.view.line)]: scenarioCode(pick) }).map((c) => [c.id, c]))
  }

  it('takes a port and budget upstream for what it uses and what it passes on', () => {
    // Four 13 W devices and the switch's own 17 W: 69 W, all of it through the upstream switch's 80 W.
    const c = run([upstream(80), flex(), ap(4)], 'PoE++ input')
    expect(c['poe-power']).toMatchObject({ verdict: 'ok' })
    expect(c['poe-layout']?.stats?.devices).toBe(5)
    expect(c['poe-layout']?.stats?.stranded).toBe(0)
    // 40 W can't carry that, though the budgets add up (40 + 46 W) to more than the 69 W drawn.
    expect(run([upstream(40), flex(), ap(4)], 'PoE++ input')['poe-power']).toMatchObject({ verdict: 'bad', text: expect.stringContaining('each switch has its own budget') })
  })

  it('needs nothing upstream when it runs on its adapter', () => {
    const c = run([flex(), ap(4)], '210W AC adapter input')
    expect(c['poe-power']).toMatchObject({ verdict: 'ok', text: 'Devices draw up to 52 W of the 196 W supplied.' })
    expect(c['poe-layout']?.stats?.devices).toBe(4)
  })

  it('leaves it with no power when nothing upstream supplies PoE', () => {
    expect(run([flex(), ap(2)], 'PoE++ input')['poe-power']).toMatchObject({ verdict: 'bad' })
  })

  it('does not let a switch power itself, or two switches each other', () => {
    const two = [flex(), item('flex2', 1, { ports: [poeOut(8, 'PoE++'), port({ count: 1, poe_class: 'PoE+++', poe_direction: 'in' })], poe_budget: scenarios, power: [{ kind: 'ac', poe_class: '', detail: '(1) AC/DC adapter (Excluded)' }], metrics: [metric('poe_budget_w', 196), metric('power_draw_excl_poe_w', 17)] })]
    const c = planChecks(two, {}, { [lineKey(two[0]!.view.line)]: scenarioCode('PoE++ input'), [lineKey(two[1]!.view.line)]: scenarioCode('PoE++ input') })
    expect(c.find((x) => x.id === 'poe-power')).toMatchObject({ verdict: 'bad' })
  })
})

describe('a switch powered over PoE has the budget of the port it is on', () => {
  const scenarios = [{ name: 'PoE+ input', watts: 16, selected: false }, { name: 'PoE++ input', watts: 46, selected: false }, { name: '210W AC adapter input', watts: 196, selected: true }]
  const flex = () => item('flex', 1, { ports: [poeOut(8, 'PoE++'), port({ count: 1, poe_class: 'PoE+++', poe_direction: 'in' })], poe_budget: scenarios, power: [{ kind: 'ac', poe_class: '', detail: '(1) AC/DC adapter (Excluded)' }], metrics: [metric('poe_budget_w', 196), metric('power_draw_excl_poe_w', 17)] })
  const up = (cls: string) => item('up', 1, { ports: [poeOut(8, cls)], metrics: [metric('poe_budget_w', 400)] })
  const run = (lines: DerivedLine[]) => {
    const f = lines.find((l) => l.view.line.ref === 'us/flex')!
    return Object.fromEntries(planChecks(lines, {}, { [lineKey(f.view.line)]: scenarioCode('PoE input') }).map((c) => [c.id, c]))
  }

  it('gets the PoE++ budget from a PoE++ port, and only the PoE+ one from a PoE+ port', () => {
    // Four 13 W devices (52 W) on the Flex: 46 W is too little, 16 W is less, and the Flex's own 17 W is in the upstream's budget.
    const on46 = run([up('PoE++'), flex(), ap(3)])
    expect(on46['poe-power']?.verdict).toBe('ok')
    expect(on46['poe-layout']?.stats?.stranded).toBe(0)
    // On a PoE+ port it has 16 W to pass on: one 13 W device fits on it, and the rest must go on the upstream.
    const onPlus = run([up('PoE+'), flex(), ap(3)])
    expect(onPlus['poe-power']?.verdict).toBe('ok')
    expect(onPlus['poe-layout']?.detail?.some((b) => b.title.startsWith('flex:') && b.title.includes('of 16 W'))).toBe(true)
    expect(on46['poe-layout']?.detail?.some((b) => b.title.startsWith('flex:') && b.title.includes('of 46 W'))).toBe(true)
  })

  it('takes the best port left, not the lowest that will do', () => {
    const c = run([item('up', 1, { ports: [poeOut(4, 'PoE+'), poeOut(4, 'PoE++')], metrics: [metric('poe_budget_w', 400)] }), flex(), ap(1)])
    expect(c['poe-layout']?.detail?.some((b) => b.title.startsWith('flex:') && b.title.includes('of 46 W'))).toBe(true)
  })

  it('cannot be powered by a port below the lowest input it takes', () => {
    expect(run([up('PoE'), flex(), ap(1)])['poe-power']?.verdict).toBe('bad')
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

describe('a PoE injector', () => {
  const ac = [src('ac')]
  const switchOf = (qty = 1, budget = 30, plain = 4) => item('sw', qty, { ports: [poeOut(4), ...(plain > 0 ? [port({ count: plain })] : [])], metrics: [metric('poe_budget_w', budget)], power: ac })
  const camera = (qty: number) => item('cam', qty, { ports: [poeIn], metrics: [metric('power_draw_max_w', 8)] })
  const injector = (qty: number, cls = 'PoE+', watts = 30, speed = 1000) =>
    item('inj', qty, { ports: [port({ count: 1, max_speed_mbps: speed, source: 'injector' }), port({ count: 1, max_speed_mbps: speed, poe_class: cls, poe_direction: 'out', source: 'injector' })], metrics: [metric('poe_budget_w', watts)], power: ac })
  // item() gives every product the default type, which isn't a switch: the switch needs its own.
  const asSwitch = (l: DerivedLine): DerivedLine => ({ ...l, view: { ...l.view, product: { ...l.view.product!, type: 'Switches' } } })

  it('powers a device the switch has no budget left for, so the plan works, and takes a switch port of its own', () => {
    const sw = asSwitch(switchOf())
    // Four cameras draw 32 W of 30 W: one is left, which says an injector would do, as there is a port to plug it into.
    const before = planChecks([camera(4), sw])
    expect(before.find((c) => c.id === 'poe-power')).toMatchObject({ verdict: 'bad', shortfall: true, injectorShortfall: true })
    const after = Object.fromEntries(planChecks([camera(4), sw, injector(1)]).map((c) => [c.id, c]))
    expect(after['poe-power']).toMatchObject({ verdict: 'ok' })
    expect(after['poe-ports']).toMatchObject({ verdict: 'ok' })
    expect(after['poe-layout']!.stats).toMatchObject({ stranded: 0, devices: 4 })
    expect(Object.values(after).some((c) => c.shortfall)).toBe(false)
    // 8 ports: one for the switch's uplink, three PoE for cameras, one for the injector, so three are spare.
    expect(after['net-ports']).toMatchObject({ verdict: 'ok', net: { spare: 3 } })
  })

  it("wants a port for the injector: with none to spare it isn't offered, and the one that was added is not placed", () => {
    const full = asSwitch(switchOf(1, 30, 0))
    // Four PoE ports and nothing else: the uplink and three cameras take them, and the fourth camera has nothing to plug into.
    expect(planChecks([camera(4), full]).some((c) => c.injectorShortfall)).toBe(false)
    expect(planChecks([camera(4), full, injector(1)]).find((c) => c.id === 'net-ports')).toMatchObject({ verdict: 'bad', shortfall: true })
  })

  it('is too weak when its class is below the device', () => {
    const sw = asSwitch(switchOf())
    const checks = Object.fromEntries(planChecks([camera(4), sw, injector(1, 'PoE', 15.4)]).map((c) => [c.id, c]))
    expect(checks['poe-power']).toMatchObject({ verdict: 'bad' })
    expect(checks['poe-layout']!.stats).toMatchObject({ stranded: 1 }) // a 15 W injector is no use to a PoE+ camera
  })

  it('is used only for what the switches cannot power, and its spare is not counted as the switches', () => {
    const sw = asSwitch(switchOf(1, 400))
    const layout = planChecks([camera(2), sw, injector(3)]).find((c) => c.id === 'poe-layout')!
    // Both cameras fit the switch, so the injectors power nothing and add no PoE port to spare.
    expect(layout.stats).toMatchObject({ stranded: 0, sparePorts: 2 })
    expect(layout.detail?.find((d) => d.title.startsWith('inj'))?.rows.every((r) => typeof r === 'string' || r.items.every((i) => i.includes('spare')))).toBe(true)
  })

  it('lets a plan with no PoE switch at all be powered by one injector for each device', () => {
    const plain = asSwitch(item('sw', 1, { ports: [port({ count: 8 })], power: ac }))
    expect(planChecks([camera(3), plain]).find((c) => c.id === 'poe-power')).toMatchObject({ shortfall: true, injectorShortfall: true })
    const fixed = Object.fromEntries(planChecks([camera(3), plain, injector(3)]).map((c) => [c.id, c]))
    expect(fixed['poe-power']).toMatchObject({ verdict: 'ok' })
    expect(fixed['net-ports']).toMatchObject({ verdict: 'ok', net: { spare: 4 } }) // 8 ports, the uplink and three injectors
    // Each injector takes a mains outlet too.
    expect(fixed['outlets']?.text).toContain('3 × inj')
  })
})


describe('a PoE injector on a gateway with only PoE devices', () => {
  it('is offered when the gateway has a data port to spare, though no ports check is shown', () => {
    const gw = item('gw', 1, { ports: [poeOut(1), port({ count: 3 })], metrics: [metric('poe_budget_w', 30)], power: [src('ac')] })
    const gateway = { ...gw, view: { ...gw.view, product: { ...gw.view.product!, type: 'Gateways' } } } as DerivedLine
    const cam = item('cam', 2, { ports: [poeIn], metrics: [metric('power_draw_max_w', 8)] })
    const checks = planChecks([cam, gateway])
    expect(checks.some((c) => c.id === 'net-ports')).toBe(false)
    expect(checks.find((c) => c.id === 'poe-power' || c.id === 'poe-ports')).toBeDefined()
    expect(checks.some((c) => c.injectorShortfall)).toBe(true)
  })
})

describe('a PoE injector that lets a device run faster than any PoE port on offer', () => {
  const ac = [src('ac')]
  const asType = (l: DerivedLine, type: string): DerivedLine => ({ ...l, view: { ...l.view, product: { ...l.view.product!, type } } })
  // A gateway with two 2.5 GbE PoE+ ports (30 W) and a 10 GbE port, a gigabit switch, a 10 GbE access point and a 10 GbE injector.
  const gateway = () => asType(item('gw', 1, { ports: [port({ count: 2, max_speed_mbps: 2500, poe_class: 'PoE+', poe_direction: 'out' }), port({ count: 1, max_speed_mbps: 10000 }), port({ count: 4 })], metrics: [metric('poe_budget_w', 30)], power: ac }), 'Gateways')
  const switchOf = () => asType(item('sw', 1, { ports: [port({ count: 4, poe_class: 'PoE+', poe_direction: 'out' }), port({ count: 4 })], metrics: [metric('poe_budget_w', 52)], power: ac }), 'Switches')
  const xg = () => item('xg', 1, { ports: [port({ count: 1, max_speed_mbps: 10000, poe_class: 'PoE+', poe_direction: 'in' })], metrics: [metric('power_draw_max_w', 22)] })
  const injector = (speed = 10000) => item('inj', 1, { ports: [port({ count: 1, max_speed_mbps: speed, source: 'injector' }), port({ count: 1, max_speed_mbps: speed, poe_class: 'PoE++', poe_direction: 'out', source: 'injector' })], metrics: [metric('poe_budget_w', 60)], power: ac })
  const run = (lines: DerivedLine[]) => {
    const trace: Trace = {}
    const checks = Object.fromEntries(planChecks(lines, {}, {}, trace).map((c) => [c.id, c]))
    return { trace, checks }
  }
  const hostOf = (t: Trace, slug: string) => t.poeHosts?.find((h) => h.line.view.line.ref === `us/${slug}`)

  it('runs the device at full speed through an injector on a fast port, though the gateway has a PoE port that powers it slower', () => {
    const { trace, checks } = run([gateway(), switchOf(), xg(), injector()])
    expect(checks['poe-speed']).toBeUndefined()
    expect(hostOf(trace, 'xg')).toMatchObject({ host: { line: { view: { line: { ref: 'us/inj' } } } }, link: { speed: 10000, capable: 10000 } })
    // The injector is plugged into the gateway's 10 GbE port, not a gigabit port on the switch.
    expect(trace.portHosts?.find((h) => h.line.view.line.ref === 'us/inj')).toMatchObject({ host: { line: { view: { line: { ref: 'us/gw' } } } }, link: { speed: 10000 } })
  })

  it('leaves the device on the PoE port when the plan has no injector to do better', () => {
    const { trace, checks } = run([gateway(), switchOf(), xg()])
    expect(hostOf(trace, 'xg')).toMatchObject({ host: { line: { view: { line: { ref: 'us/gw' } } } }, link: { speed: 2500, capable: 10000 } })
    expect(checks['poe-speed']).toMatchObject({ verdict: 'warn' })
  })

  it('does not count an injector as faster than the port it is plugged into', () => {
    // Nothing on a gateway or a switch is faster than 2.5 GbE here, so the injector gains nothing and the device stays on the gateway's PoE port.
    const slowGateway = asType(item('gw', 1, { ports: [port({ count: 2, max_speed_mbps: 2500, poe_class: 'PoE+', poe_direction: 'out' }), port({ count: 4, max_speed_mbps: 2500 })], metrics: [metric('poe_budget_w', 30)], power: ac }), 'Gateways')
    const { trace } = run([slowGateway, switchOf(), xg(), injector()])
    expect(hostOf(trace, 'xg')).toMatchObject({ host: { line: { view: { line: { ref: 'us/gw' } } } }, link: { speed: 2500 } })
  })

  it('says a device on an injector plugged into a gigabit port is slowed to gigabit', () => {
    // The only data ports are the switch's gigabit ones and a gateway with no spare fast port: the 10 GbE injector can't do better than 1 GbE.
    const gw = asType(item('gw', 1, { ports: [port({ count: 1, max_speed_mbps: 1000 })], power: ac }), 'Gateways')
    const { trace, checks } = run([gw, switchOf(), xg(), injector()])
    const h = hostOf(trace, 'xg')
    expect(h?.link.speed).toBeLessThanOrEqual(2500)
    expect(checks['poe-speed']).toMatchObject({ verdict: 'warn' })
  })

  it('does not put an injector that powers nothing on the gateway for its speed', () => {
    const cam = item('cam', 1, { ports: [poeIn], metrics: [metric('power_draw_max_w', 8)] })
    const { trace } = run([gateway(), switchOf(), cam, injector()])
    expect(trace.portHosts?.find((h) => h.line.view.line.ref === 'us/inj')).toMatchObject({ host: { line: { view: { line: { ref: 'us/sw' } } } } })
  })
})

describe('spare ports and where PoE devices go, with a gateway and two switches', () => {
  const ac = [src('ac')]
  const asType = (l: DerivedLine, type: string): DerivedLine => ({ ...l, view: { ...l.view, product: { ...l.view.product!, type } } })
  // A gateway with a 2.5 GbE PoE+ port and a 10G SFP+; a big switch with 2.5 GbE PoE++ ports and SFP+ cages; a small 10 GbE PoE++ one with SFP+ cages.
  const gateway = () => asType(item('gw', 1, { ports: [port({ count: 2, max_speed_mbps: 2500, poe_class: 'PoE+', poe_direction: 'out' }), port({ count: 2, media: 'sfp+', max_speed_mbps: 10000 })], metrics: [metric('poe_budget_w', 30)], power: ac }), 'Gateways')
  const big = () => asType(item('big', 1, { ports: [port({ count: 16, max_speed_mbps: 2500, poe_class: 'PoE++', poe_direction: 'out' }), port({ count: 8, max_speed_mbps: 1000 }), port({ count: 4, media: 'sfp+', max_speed_mbps: 10000 })], metrics: [metric('poe_budget_w', 600)], power: ac }), 'Switches')
  const small = () => asType(item('small', 1, { ports: [port({ count: 8, max_speed_mbps: 10000, poe_class: 'PoE++', poe_direction: 'out' }), port({ count: 2, media: 'sfp+', max_speed_mbps: 10000 })], metrics: [metric('poe_budget_w', 155)], power: ac }), 'Switches')
  const apXg = (qty: number) => item('apxg', qty, { ports: [port({ count: 1, max_speed_mbps: 10000, poe_class: 'PoE++', poe_direction: 'in' })], metrics: [metric('power_draw_max_w', 25)] })
  const modem = () => item('modem', 1, { ports: [port({ count: 1, max_speed_mbps: 2500, poe_class: 'PoE+', poe_direction: 'in' })], metrics: [metric('power_draw_max_w', 14.5)] })
  const spareOn = (t: Trace, slug: string) => t.spare?.find((s) => s.unit.line.view.line.ref === `us/${slug}`)?.spare
  const run = (lines: DerivedLine[]) => {
    const trace: Trace = {}
    planChecks(lines, {}, {}, trace)
    return trace
  }

  it('takes the PoE ports each switch is using out of that switch’s spare ports, not out of whichever switch’s ports are slowest', () => {
    // The small switch carries the four 10 GbE access points; the big one carries nothing but is uplinked, with the small one, to the gateway.
    const t = run([gateway(), big(), small(), apXg(4)])
    expect(t.poeHosts?.every((h) => h.host.line.view.line.ref === 'us/small')).toBe(true)
    // 10 ports on the small switch, one for its uplink and four for the access points.
    expect(spareOn(t, 'small')).toBe(5)
    // 28 ports on the big one, and only an uplink on it (or none): nothing of the small switch's PoE load is charged to it.
    expect(spareOn(t, 'big')).toBeGreaterThanOrEqual(26)
  })

  it('puts a PoE device on a switch with room rather than on the gateway’s PoE port, though the gateway’s class is lower', () => {
    const t = run([gateway(), big(), modem()])
    expect(t.poeHosts?.find((h) => h.line.view.line.ref === 'us/modem')?.host.line.view.line.ref).toBe('us/big')
  })

  it('still uses the gateway’s PoE port when no switch can power the device', () => {
    const t = run([gateway(), modem()])
    expect(t.poeHosts?.find((h) => h.line.view.line.ref === 'us/modem')?.host.line.view.line.ref).toBe('us/gw')
  })
})
