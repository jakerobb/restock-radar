import { derived } from '../test/fixtures'
import { viewLine, type PlanLine } from './plan'
import { product } from '../test/fixtures'
import type { DerivedLine } from './planChecks'
import { adapterOf, assumeBest, budgetOf, includedScenario, needsPowerChoice, powerOptions, scenarioCode } from './powering'
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
    expect(powerOptions(flex().derived)!.map((o) => [o.scenario.name, o.adapter?.slug ?? null])).toEqual([
      ['PoE+++ input', null], ['PoE++ input', null], ['PoE+ input', null], ['210W AC adapter input', 'uacc-adapter-ac-210w'],
    ])
    // The Ultra with no adapter in the box can't use the 60 W ones, which aren't sold alone.
    const bare = line('ultra', { poe_budget: ULTRA, power: [power('ac', '(1) AC/DC adapter (Excluded)')] })
    expect(powerOptions(bare.derived)!.map((o) => o.scenario.name)).toEqual(['PoE++ input', 'PoE+ input', '210W AC adapter input'])
    // With the 60 W adapter in the box, it is on offer, free, and the 210 W one is still one to buy.
    const inBox = powerOptions(ultra60().derived)!
    expect(inBox.map((o) => [o.scenario.name, o.adapter !== null])).toEqual([['PoE++ input', false], ['PoE+ input', false], ['60W AC adapter input', false], ['210W AC adapter input', true]])
  })

  it('knows no budget until one is chosen, unless there is a power supply in the box', () => {
    const f = flex()
    expect(budgetOf(f, {})).toMatchObject({ watts: null, choose: true })
    const code = scenarioCode('PoE+ input')
    expect(budgetOf(f, { [lineKey(f.view.line)]: code })).toMatchObject({ watts: 16, choose: false })
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
