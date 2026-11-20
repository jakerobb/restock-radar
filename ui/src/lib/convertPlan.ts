import type { Product, Variant } from '../api/types'
import { productRef } from './compare'
import { addLine, lineKey, type PlanLine } from './plan'
import type { Powering } from './powering'

/** What became of one line of the plan. */
export interface LineOutcome {
  line: PlanLine
  title: string
  /** 'same': the same SKU; 'counterpart': the region's own SKU for it (UNAS-2-B is UNAS-2-B-EU there); 'left': nothing there matches. */
  result: 'same' | 'counterpart' | 'left'
  /** Why a line was left out. */
  why?: 'untracked' | 'not-sold' | 'no-variant'
  /** What the line is in the new region. */
  to?: PlanLine
}

export interface Conversion {
  lines: PlanLine[]
  powering: Powering
  outcomes: LineOutcome[]
  /** How many lines (not items) were left out. */
  left: number
}

const REGION_SUFFIX = /-(US|CA|EU|UK|GB|JP|BR|TW|SG|AU|IN|ME|ZA|CN|MX|PH)$/i

/** A SKU without the region it is sold in: "UNAS-2-B-EU" is "UNAS-2-B". */
export const baseSku = (sku: string): string => sku.replace(REGION_SUFFIX, '')

/** The variant of `to` that stands for `from`: the same SKU, else the same SKU bar its region, else the same name, else the only one there is. */
export function matchVariant(from: Variant, source: Product, to: Product): Variant | undefined {
  const exact = to.variants.find((v) => v.sku === from.sku)
  if (exact) return exact
  const base = baseSku(from.sku).toLowerCase()
  const bySku = to.variants.filter((v) => baseSku(v.sku).toLowerCase() === base)
  if (bySku.length === 1) return bySku[0]
  const title = from.title.trim().toLowerCase()
  const byTitle = title === '' ? [] : to.variants.filter((v) => v.title.trim().toLowerCase() === title)
  if (byTitle.length === 1) return byTitle[0]
  if (source.variants.length === 1 && to.variants.length === 1) return to.variants[0]
  return undefined
}

/** The product in region `region` that is the same product as `p`: the store's product ids agree across regions, and a slug is the fallback. */
export function counterpart(p: Product, region: string, products: Product[]): Product | undefined {
  return products.find((x) => x.region === region && x.id === p.id) ?? products.find((x) => x.region === region && x.slug === p.slug)
}

/**
 * The plan as it would be in another region. Prices aren't carried over (the other store prices
 * things its own way, in its own currency); whoever opens the result sees its prices. A line the
 * region doesn't sell, or has no matching variant of, is left out and reported.
 */
export function convertPlan(lines: PlanLine[], powering: Powering, products: Product[], region: string): Conversion {
  const byRef = new Map(products.map((p) => [productRef(p), p]))
  const outcomes: LineOutcome[] = []
  let out: PlanLine[] = []
  const rekey = new Map<string, string>()
  for (const line of lines) {
    const source = byRef.get(line.ref)
    if (!source) {
      outcomes.push({ line, title: line.ref, result: 'left', why: 'untracked' })
      continue
    }
    const title = source.title
    const target = counterpart(source, region, products)
    if (!target) {
      outcomes.push({ line, title, result: 'left', why: 'not-sold' })
      continue
    }
    const from = source.variants.find((v) => v.sku === line.sku)
    const variant = from && matchVariant(from, source, target)
    if (!variant) {
      outcomes.push({ line, title, result: 'left', why: 'no-variant' })
      continue
    }
    const to: PlanLine = { ref: productRef(target), sku: variant.sku, qty: line.qty, addedCents: null }
    out = addLine(out, to)
    rekey.set(lineKey(line), lineKey(to))
    outcomes.push({ line, title, to, result: variant.sku === line.sku ? 'same' : 'counterpart' })
  }
  const converted: Powering = {}
  for (const [from, code] of Object.entries(powering)) {
    const to = rekey.get(from)
    if (to) converted[to] = code
  }
  return { lines: out, powering: converted, outcomes, left: outcomes.filter((o) => o.result === 'left').length }
}
