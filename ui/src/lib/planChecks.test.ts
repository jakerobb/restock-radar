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
const poeOut = (n: number) => port({ count: n, poe_class: 'PoE+', poe_direction: 'out' })
const ap = (qty: number, draw: number | null = 13) => item('ap', qty, { ports: [poeIn], metrics: draw === null ? [] : [metric('power_draw_max_w', draw)] })
const sw = (qty: number, budget: number | null, ports = 8) => item('sw', qty, { ports: [poeOut(ports)], metrics: budget === null ? [] : [metric('poe_budget_w', budget)] })
const byId = (lines: DerivedLine[]) => Object.fromEntries(planChecks(lines).map((c) => [c.id, c]))

describe('planChecks', () => {
  it('says the devices fit, with the numbers', () => {
    const c = byId([ap(4), sw(1, 100)])
    expect(c['poe-power']).toMatchObject({ verdict: 'ok', text: 'Devices draw up to 52 W of the 100 W supplied.' })
    expect(c['poe-ports']).toMatchObject({ verdict: 'ok', text: '4 PoE-powered devices for 8 PoE ports.' })
  })

  it('multiplies by quantity on both sides', () => {
    const c = byId([ap(10, 13), sw(2, 60, 4)])
    expect(c['poe-power']).toMatchObject({ verdict: 'bad', text: 'Devices can draw up to 130 W, over the 120 W the plan supplies.' })
    expect(c['poe-ports']).toMatchObject({ verdict: 'bad', text: '10 PoE-powered devices for 8 PoE ports.' })
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

  it('ignores products whose ports aren’t known, and says nothing when nothing applies', () => {
    expect(planChecks([item('mystery', 1, { known: { ...known, ports: false }, ports: [poeIn] }), item('nodata', 1, null)])).toEqual([])
  })

  it('adds up rack space, and says when a height is missing', () => {
    const rack = (slug: string, qty: number, units: number) => item(slug, qty, { rack: { mountable: true, units, full_depth: false } })
    expect(byId([rack('sw', 2, 2), rack('gw', 1, 1), item('ap', 1, { rack: { mountable: false, units: 0, full_depth: false } })]).rack).toMatchObject({ verdict: 'info', text: '5U of rack space (2 × sw 2U, gw 1U).' })
    expect(byId([rack('sw', 1, 2), rack('odd', 1, 0)]).rack).toMatchObject({ verdict: 'unknown', text: expect.stringContaining("height of odd isn't known") })
  })
})
