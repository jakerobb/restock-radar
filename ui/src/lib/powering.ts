import type { Derived, PoEScenario } from '../api/types'
import { lineKey } from './plan'
import type { DerivedLine } from './planChecks'

/**
 * How a plan's switches are powered where the product can be powered several ways, each with a budget of its own
 * downstream (a Flex 2.5G PoE gives 16 W on PoE+ but 196 W on its optional adapter). The choice is a scenario
 * of the product's PoE budget, by a code made from its name, kept by the line's key. A line with no entry hasn't been chosen.
 */
export type Powering = Record<string, number>

/** A small stable number for a scenario's name, which is what a share link carries (1 to 65535). */
export function scenarioCode(name: string): number {
  let h = 0x811c9dc5
  for (const c of name.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193)
  return ((h >>> 0) & 0xffff) || 1
}

/**
 * The AC adapters the store sells separately, by their watts, as products. The store gives no list of which
 * adapter a switch takes, so the scenarios' names ("210W AC adapter input") are matched to these.
 */
export const ADAPTER_PRODUCTS: Record<number, string> = { 210: 'uacc-adapter-ac-210w' }

const ADAPTER = /(\d+)\s*W\s+(?:AC|PoE)?\s*adapter/i

/** The adapter a scenario runs on, with its watts; null when it isn't one. */
export function adapterOf(s: PoEScenario): { watts: number; slug: string | null; poe: boolean } | null {
  // "PoE++/60W PoE adapter input" is PoE, however it is supplied.
  if (/^poe/i.test(s.name)) return null
  const m = ADAPTER.exec(s.name)
  if (!m) return null
  const watts = Number(m[1])
  return { watts, slug: /AC/i.test(s.name) ? (ADAPTER_PRODUCTS[watts] ?? null) : null, poe: /PoE adapter/i.test(s.name) }
}

/** The scenario of a product that comes with its own power supply (an adapter in the box); null when it doesn't, or the store doesn't say. */
export function includedScenario(d: Derived): PoEScenario | null {
  if (!d.power.some((p) => p.kind === 'ac' && /\bincluded\b/i.test(p.detail))) return null
  return d.poe_budget.find((s) => s.selected) ?? null
}

/** Whether a scenario's name is about how the switch is powered in, as opposed to a mode of the mains supply ("Shared Mode"). */
const isInput = (s: PoEScenario) => /poe|adapter/i.test(s.name)

/** True when the buyer has to say how a product is powered: several PoE or adapter inputs, none of them in the box. */
export function needsPowerChoice(d: Derived): boolean {
  return d.poe_budget.length > 1 && d.poe_budget.some(isInput) && includedScenario(d) === null
}

/** The PoE class a scenario takes its power in at ("PoE+ input" is PoE+); null when it runs on an adapter or the mains. */
export function poeClassOf(s: PoEScenario): string | null {
  const m = /^(PoE\+{0,3})(?![\w+])/i.exec(s.name)
  return m ? m[1]!.replace(/^poe/i, 'PoE') : null
}

export interface PowerOption {
  scenario: PoEScenario
  code: number
  /** The class of PoE port upstream that powers the switch on this input; null when it isn't PoE-powered. */
  poeClass: string | null
  /** The adapter the scenario needs bought, which the plan then has to hold; null when it needs none. */
  adapter: { watts: number; slug: string } | null
}

/**
 * The ways a product can be powered that a buyer can have: PoE inputs, and the adapter in the box or one the store
 * sells (the others, such as a 60 W adapter sold only with a model, are left out). Null when there's nothing to choose.
 */
export function powerOptions(d: Derived | null): PowerOption[] | null {
  if (!d || d.poe_budget.length < 2 || !d.poe_budget.some(isInput)) return null
  const included = includedScenario(d)
  const out: PowerOption[] = []
  for (const s of d.poe_budget) {
    const a = adapterOf(s)
    if (a && included?.name !== s.name && !a.slug) continue
    out.push({ scenario: s, code: scenarioCode(s.name), poeClass: poeClassOf(s), adapter: a && a.slug && included?.name !== s.name ? { watts: a.watts, slug: a.slug } : null })
  }
  return out.length > 1 ? out : null
}

/** What a line's PoE budget is, given the choices made. Null watts means it isn't known; `choose` says why, when the buyer has yet to say. */
export function budgetOf(l: DerivedLine, powering: Powering): { watts: number | null; choose: boolean; option: PowerOption | null } {
  const d = l.derived
  const fromMetric = d?.metrics.find((m) => m.name === 'poe_budget_w')?.value
  const plain = typeof fromMetric === 'number' && fromMetric > 0 ? fromMetric : null
  const options = powerOptions(d)
  if (!d || !options) return { watts: plain, choose: false, option: null }
  const included = includedScenario(d)
  const code = powering[lineKey(l.view.line)]
  let option = options.find((o) => o.code === code) ?? null
  if (!option && included) option = options.find((o) => o.scenario.name === included.name) ?? null
  if (!option) return { watts: null, choose: needsPowerChoice(d), option: null }
  return { watts: option.scenario.watts, choose: false, option }
}

/** For the finders, which try switches nobody has chosen the power of: each is taken to run on its best input. */
export function assumeBest(lines: DerivedLine[]): Powering {
  const out: Powering = {}
  for (const l of lines) {
    const best = powerOptions(l.derived)?.find((o) => o.scenario.selected)
    if (best) out[lineKey(l.view.line)] = best.code
  }
  return out
}
