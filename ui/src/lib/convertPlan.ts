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

/** The region a SKU says it is for, lower case ("eu" for "UNAS-2-B-EU"), or '' when it names none. */
const skuRegion = (sku: string): string => (REGION_SUFFIX.exec(sku)?.[1] ?? '').toLowerCase().replace('gb', 'uk')

/**
 * The variant of `to` that stands for `from`: the same SKU, else the same SKU bar its region, else the
 * same name, else the only one there is. A store may sell several regional versions of one SKU (the
 * European store lists both an EU and a UK plug), so among those the one made for `region` is taken,
 * else the one that names no region.
 */
export function matchVariant(from: Variant, source: Product, to: Product, region = to.region): Variant | undefined {
  const exact = to.variants.find((v) => v.sku === from.sku)
  if (exact) return exact
  const base = baseSku(from.sku).toLowerCase()
  const bySku = to.variants.filter((v) => baseSku(v.sku).toLowerCase() === base)
  if (bySku.length === 1) return bySku[0]
  if (bySku.length > 1) {
    const made = bySku.filter((v) => skuRegion(v.sku) === region)
    if (made.length === 1) return made[0]
    const plain = bySku.filter((v) => skuRegion(v.sku) === '')
    if (made.length === 0 && plain.length === 1) return plain[0]
  }
  const title = from.title.trim().toLowerCase()
  const byTitle = title === '' ? [] : to.variants.filter((v) => v.title.trim().toLowerCase() === title)
  if (byTitle.length === 1) return byTitle[0]
  if (source.variants.length === 1 && to.variants.length === 1) return to.variants[0]
  return undefined
}

const SLUG_REGION = /-(us|ca|eu|uk|gb|jp|br|tw|sg)$/

/** A slug without the region it is sold in: "ups-tower-eu" is "ups-tower". */
export const baseSlug = (slug: string): string => slug.replace(SLUG_REGION, '')

/**
 * The product in region `region` that is the same product as `p`. The store's product ids agree across
 * regions for most products, and so do slugs. Some products it sells as a separate product in each
 * region, with its own id and a regional slug ("ups-tower-us", "ups-tower-eu"), so failing those the
 * slug without its region is tried, and then the title, each only when it names one product.
 */
export function counterpart(p: Product, region: string, products: Product[]): Product | undefined {
  const there = products.filter((x) => x.region === region)
  const exact = there.find((x) => x.id === p.id) ?? there.find((x) => x.slug === p.slug)
  if (exact) return exact
  const only = (list: Product[]): Product | undefined => {
    if (list.length <= 1) return list[0]
    return list.filter((x) => SLUG_REGION.exec(x.slug)?.[1] === region).length === 1 ? list.find((x) => SLUG_REGION.exec(x.slug)?.[1] === region) : undefined
  }
  const bySlug = only(there.filter((x) => baseSlug(x.slug) === baseSlug(p.slug)))
  if (bySlug) return bySlug
  const title = p.title.trim().toLowerCase()
  return title === '' ? undefined : only(there.filter((x) => x.title.trim().toLowerCase() === title))
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
    const variant = from && matchVariant(from, source, target, region)
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
