import { derived } from '../test/fixtures'
import { viewLine, type PlanLine } from './plan'
import { product } from '../test/fixtures'
import type { DerivedLine } from './planChecks'
import { adapterOf, assumeBest, poeBudgetAt, POE_CODE, withSiblings, budgetOf, includedScenario, needsPowerChoice, powerOptions, scenarioCode } from './powering'
import { lineKey } from './plan'

const scenario = (name: string, watts: number, selected = false) => ({ name, watts, selected })
const power = (kind: 'ac' | 'poe', detail: string) => ({ kind, poe_class: '', detail })

// The Flex 2.5G PoE and the Ultra family, as the store words them.
const FLEX = [scenario('PoE+++ input', 76), scenario('PoE++ input', 46), scenario('PoE+ input', 16), scenario('210W AC adapter input', 196, true)]
const ULTRA = [scenario('PoE++ input', 42), scenario('PoE+ input', 16), scenario('60W PoE adapter input', 42), scenario('60W AC adapter input', 52), scenario('210W AC adapter input', 202, true)]

const line = (slug: string, d: Partial<Parameters<typeof derived>[0]>): DerivedLine => {
  const l: PlanLine = { ref: `us/${slug}`, sku: 'SKU-1', qty: 1, addedCents: null }
  return { view: viewLine(l, new Map([[l.ref, product({ slug, title: slug })]])), derived: derived({ slug, ...d }) }
}
const flex = () => line('flex', { poe_budget: FLEX, power: [power('ac', '(1) AC/DC adapter (Excluded)')] })
const ultra60 = () => line('ultra-60', { poe_budget: ULTRA.map((s) => ({ ...s, selected: s.name === '60W AC adapter input' })), power: [power('ac', '(1) AC/DC adapter (Included)')] })

describe('powering a switch', () => {
  it('reads the adapter a scenario runs on, and which the store sells', () => {
    expect(adapterOf(scenario('210W AC adapter input', 1))).toEqual({ watts: 210, slug: 'uacc-adapter-ac-210w', poe: false })
    expect(adapterOf(scenario('60W AC adapter input', 1))).toMatchObject({ watts: 60, slug: null })
    expect(adapterOf(scenario('60W PoE adapter input', 1))).toMatchObject({ poe: true, slug: null })
    expect(adapterOf(scenario('PoE+ input', 1))).toBeNull()
  })

  it('needs a choice when several inputs are on offer and none is in the box', () => {
    expect(needsPowerChoice(flex().derived!)).toBe(true)
    expect(needsPowerChoice(ultra60().derived!)).toBe(false)
    expect(includedScenario(ultra60().derived!)?.name).toBe('60W AC adapter input')
    // Mains modes of an enterprise switch are not a choice of how to power it.
    expect(powerOptions(derived({ poe_budget: [scenario('200-240V AC Shared Mode', 2150, true), scenario('100-120V AC Shared Mode', 1850)] }))).toBeNull()
  })

  it('offers PoE and the adapter that can be had, and leaves out one sold only with another model', () => {
    // Every PoE input is one option, whose budget is that of the port the switch is on.
    const o = powerOptions(flex().derived)!
    expect(o.map((x) => [x.poeInputs ? 'PoE' : x.scenario.name, x.adapter?.slug ?? null])).toEqual([['PoE', null], ['210W AC adapter input', 'uacc-adapter-ac-210w']])
    expect(o[0]!.poeClass).toBe('PoE+')
    expect([1, 2, 3, 4].map((rank) => poeBudgetAt(o[0]!, rank))).toEqual([null, 16, 46, 76])
    // The Ultra with no adapter in the box can't use the 60 W ones, which aren't sold alone.
    const bare = line('ultra', { poe_budget: ULTRA, power: [power('ac', '(1) AC/DC adapter (Excluded)')] })
    expect(powerOptions(bare.derived)!.map((o) => (o.poeInputs ? 'PoE' : o.scenario.name))).toEqual(['PoE', '210W AC adapter input'])
    // With the 60 W adapter in the box, it is on offer, free, and the 210 W one is still one to buy.
    const inBox = powerOptions(ultra60().derived)!
    expect(inBox.map((o) => [o.poeInputs ? 'PoE' : o.scenario.name, o.adapter !== null])).toEqual([['PoE', false], ['60W AC adapter input', false], ['210W AC adapter input', true]])
  })

  it('knows no budget until one is chosen, unless there is a power supply in the box', () => {
    const f = flex()
    expect(budgetOf(f, {})).toMatchObject({ watts: null, choose: true })
    // On PoE it is the best the ports can give that is known; the plan works out which port it is on. A choice made by class, before it was one option, is that choice.
    expect(budgetOf(f, { [lineKey(f.view.line)]: POE_CODE })).toMatchObject({ watts: 76, choose: false })
    expect(budgetOf(f, { [lineKey(f.view.line)]: scenarioCode('PoE+ input') })).toMatchObject({ watts: 76, choose: false })
    expect(budgetOf(ultra60(), {})).toMatchObject({ watts: 52, choose: false })
    expect(budgetOf(line('plain', { metrics: [{ name: 'poe_budget_w', value: 100, unit: 'W', at_least: false, raw: '' }] }), {}).watts).toBe(100)
  })

  it('assumes the best input for a finder to try', () => {
    const f = flex()
    expect(budgetOf(f, assumeBest([f])).watts).toBe(196)
  })

  it('gives each name a code that is the same each time', () => {
    expect(scenarioCode('PoE+ input')).toBe(scenarioCode('poe+ input'))
    expect(scenarioCode('PoE+ input')).not.toBe(scenarioCode('PoE++ input'))
    for (const s of FLEX) expect(scenarioCode(s.name)).toBeGreaterThanOrEqual(1)
  })
})

describe('the products of a range with an adapter in the box', () => {
  const bare = () => line('ultra', { poe_budget: ULTRA, power: [power('ac', '(1) AC/DC adapter (Excluded)')] })
  const w60 = () => line('ultra-60', { poe_budget: ULTRA.map((s) => ({ ...s, selected: s.name === '60W AC adapter input' })), power: [power('ac', '(1) AC/DC adapter (Included)')] })
  const w210 = () => line('ultra-210', { poe_budget: ULTRA, power: [power('ac', '(1) AC/DC adapter (Included)')] })
  const siblings = [{ slug: 'ultra-60', derived: w60().derived! }, { slug: 'ultra-210', derived: w210().derived! }]

  it('makes the 60 W and 210 W adapters a matter of which product it is, on the one without', () => {
    const o = withSiblings(powerOptions(bare().derived)!, bare().derived!, siblings)
    expect(o.map((x) => [x.poeInputs ? 'PoE' : x.scenario.name, x.swapSlug ?? null, x.adapter?.slug ?? null])).toEqual([
      ['PoE', null, null], ['60W AC adapter input', 'ultra-60', null], ['210W AC adapter input', 'ultra-210', null],
    ])
  })

  it('offers the other adapter as a product, not the one it has, on one with an adapter in the box', () => {
    const o = withSiblings(powerOptions(w60().derived)!, w60().derived!, [{ slug: 'ultra', derived: bare().derived! }, { slug: 'ultra-210', derived: w210().derived! }])
    expect(o.map((x) => [x.poeInputs ? 'PoE' : x.scenario.name, x.swapSlug ?? null])).toEqual([['PoE', null], ['60W AC adapter input', null], ['210W AC adapter input', 'ultra-210']])
  })

  it('leaves a product with no sibling that comes with the adapter to the adapter it can buy', () => {
    const f = flex()
    expect(withSiblings(powerOptions(f.derived)!, f.derived!, []).find((x) => x.scenario.name === '210W AC adapter input')?.adapter?.slug).toBe('uacc-adapter-ac-210w')
  })
})
