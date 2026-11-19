import type { Derived, PoEScenario } from '../api/types'
import { lineKey } from './plan'
import type { DerivedLine } from './planChecks'
import { POE_CLASSES } from './requirements'

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
  return (powerOptions(d)?.length ?? 0) > 1 && includedScenario(d) === null
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
  /** The product of the same range that comes with the adapter in the box (a Switch Ultra 60W): to get this, the line becomes that product. */
  swapSlug?: string
  /**
   * For the PoE option, the budgets it has by class of port, lowest first: a switch that takes PoE+ and PoE++ gets the
   * PoE++ budget from a PoE++ port and the PoE+ one from a PoE+ port, so which class it has is where it is plugged in, not a choice.
   */
  poeInputs?: { name: string; rank: number; watts: number }[]
}

const poeRank = (c: string) => POE_CLASSES.indexOf(c as (typeof POE_CLASSES)[number]) + 1

/** The budget a PoE-powered switch has on a port of this class rank, which is that of the best input the port can supply; null when it supplies none. */
export function poeBudgetAt(o: PowerOption, rank: number): number | null {
  const fit = (o.poeInputs ?? []).filter((i) => i.rank <= rank)
  return fit.length === 0 ? null : Math.max(...fit.map((i) => i.watts))
}

/** The code of the PoE option, which stands for every PoE input: the class is where it is plugged in. */
export const POE_CODE = scenarioCode('PoE input')

/**
 * The ways a product can be powered that a buyer can have: PoE inputs, and the adapter in the box or one the store
 * sells (the others, such as a 60 W adapter sold only with a model, are left out). Null when there's nothing to choose.
 */
export function powerOptions(d: Derived | null): PowerOption[] | null {
  if (!d || d.poe_budget.length < 2 || !d.poe_budget.some(isInput)) return null
  const included = includedScenario(d)
  const out: PowerOption[] = []
  // Every PoE input is one option: which it is depends on the port.
  const inputs = d.poe_budget.flatMap((s) => {
    const cls = poeClassOf(s)
    return cls === null ? [] : [{ name: s.name, rank: poeRank(cls), watts: s.watts, cls }]
  }).sort((a, b) => a.rank - b.rank)
  let poeDone = false
  for (const s of d.poe_budget) {
    if (poeClassOf(s) !== null) {
      if (!poeDone) {
        poeDone = true
        const best = inputs.reduce((a, b) => (b.watts > a.watts ? b : a))
        out.push({ scenario: d.poe_budget.find((x) => x.name === best.name)!, code: POE_CODE, poeClass: inputs[0]!.cls, adapter: null, poeInputs: inputs.map(({ name, rank, watts }) => ({ name, rank, watts })) })
      }
      continue
    }
    const a = adapterOf(s)
    if (a && included?.name !== s.name && !a.slug) continue
    out.push({ scenario: s, code: scenarioCode(s.name), poeClass: poeClassOf(s), adapter: a && a.slug && included?.name !== s.name ? { watts: a.watts, slug: a.slug } : null })
  }
  return out.length > 1 || inputs.length > 1 ? out : null
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
  // A choice of one input by name, from before they were one option, is the PoE option.
  let option = options.find((o) => o.code === code || o.poeInputs?.some((i) => scenarioCode(i.name) === code)) ?? null
  if (!option && options.length === 1) option = options[0]!
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

/**
 * Adds what the other products of a range offer: a Switch Ultra comes without an adapter, with a 60 W one or with a 210 W one,
 * each its own product, so those ways of powering it are a matter of which product it is. For each sibling with an adapter
 * in the box, that adapter's scenario names it (and stops being an adapter to buy, if it was one).
 */
export function withSiblings(options: PowerOption[], d: Derived, siblings: { slug: string; derived: Derived }[]): PowerOption[] {
  const out = [...options]
  for (const sib of siblings) {
    const inc = includedScenario(sib.derived)
    if (!inc) continue
    const at = out.findIndex((o) => o.scenario.name === inc.name)
    if (at >= 0) {
      if (includedScenario(d)?.name !== inc.name) out[at] = { ...out[at]!, adapter: null, swapSlug: sib.slug }
    } else if (d.poe_budget.some((s) => s.name === inc.name)) {
      out.push({ scenario: inc, code: scenarioCode(inc.name), poeClass: poeClassOf(inc), adapter: null, swapSlug: sib.slug })
    }
  }
  const order = (o: PowerOption) => d.poe_budget.findIndex((s) => s.name === o.scenario.name)
  return out.sort((a, b) => order(a) - order(b))
}
