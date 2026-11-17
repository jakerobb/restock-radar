import { planChecks, type DerivedLine } from './planChecks'
import { viewLine, type PlanLine } from './plan'
import { derived, port, product } from '../test/fixtures'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
const metric = (name: string, value: number) => ({ name, value, unit: 'W', at_least: false, raw: '' })

const item = (slug: string, qty: number, d: Parameters<typeof derived>[0] | null): DerivedLine => {
  const l: PlanLine = { ref: `us/${slug}`, sku: 'S', qty, addedCents: null }
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
})
