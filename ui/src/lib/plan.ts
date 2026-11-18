import type { Product, Variant } from '../api/types'
import { totalCents } from './format'
import { cleanRefs, productRef } from './compare'

/** One line of the build plan: a variant of a product, and how many. */
export interface PlanLine {
  /** The product, as "region/slug". */
  ref: string
  /** The variant, by SKU. */
  sku: string
  qty: number
  /** What one cost, out the door, when the line was added; null if no price was shown then. */
  addedCents: number | null
}

export const MAX_QTY = 99
/** More lines than anyone plans; a bound so a crafted link can't build a huge page. */
export const MAX_LINES = 100

export const lineKey = (l: Pick<PlanLine, 'ref' | 'sku'>): string => `${l.ref}:${encodeURIComponent(l.sku)}`

/** A line as text, for the URL and for storage: "us/usw-pro:USW-PRO-24:2:19900". */
export const serializeLine = (l: PlanLine): string => `${lineKey(l)}:${l.qty}:${l.addedCents ?? ''}`

/** The inverse; null for anything malformed. */
export function parseLine(text: unknown): PlanLine | null {
  if (typeof text !== 'string') return null
  const parts = text.split(':')
  if (parts.length !== 4) return null
  const [ref, rawSku, rawQty, rawAdded] = parts as [string, string, string, string]
  if (cleanRefs([ref]).length !== 1) return null
  let sku: string
  try {
    sku = decodeURIComponent(rawSku)
  } catch {
    return null
  }
  if (sku === '' || !/^\d{1,2}$/.test(rawQty)) return null
  const qty = Number(rawQty)
  if (qty < 1 || qty > MAX_QTY) return null
  if (rawAdded !== '' && !/^\d{1,9}$/.test(rawAdded)) return null
  return { ref, sku, qty, addedCents: rawAdded === '' ? null : Number(rawAdded) }
}

/** The lines in a list of texts, skipping the malformed and repeated ones. */
export function parsePlan(list: unknown): PlanLine[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: PlanLine[] = []
  for (const item of list) {
    const l = parseLine(item)
    if (!l || seen.has(lineKey(l))) continue
    seen.add(lineKey(l))
    out.push(l)
    if (out.length >= MAX_LINES) break
  }
  return out
}

// ---- Share links ----
//
// A shared plan is a slug: for each line, the variant's permanent number (which says which product, in
// which region, and which variant) and the quantity, each as a variable-length integer, in base64url.
// Prices don't travel; whoever opens the link sees today's.

/** Longest slug we'll read; MAX_LINES lines need well under this. */
export const MAX_SLUG = 600

const toBase64Url = (b: number[]): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromBase64Url = (s: string): number[] => [...atob(s.replace(/-/g, '+').replace(/_/g, '/'))].map((c) => c.charCodeAt(0))

function writeVarint(out: number[], n: number): void {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
}

/** Reads one integer starting at bytes[at]; null when the bytes run out or it is implausibly long. */
function readVarint(bytes: number[], at: number): { value: number; next: number } | null {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const b = bytes[at + i]
    if (b === undefined) return null
    value += (b & 0x7f) * 128 ** i
    if (b < 0x80) return { value, next: at + i + 1 }
  }
  return null
}

/** The variants by number: which product (as "region/slug") and which SKU each is. */
export function variantsByNum(products: Iterable<Product>): Map<number, { ref: string; sku: string }> {
  const out = new Map<number, { ref: string; sku: string }>()
  for (const p of products) for (const v of p.variants) out.set(v.num, { ref: productRef(p), sku: v.sku })
  return out
}

/**
 * A plan as a short URL-safe slug. Lines whose variant isn't in the catalogue have no number and
 * are left out, so there may be nothing to share (an empty slug).
 */
export function encodePlan(lines: PlanLine[], products: Iterable<Product>): string {
  const numByKey = new Map<string, number>()
  for (const [num, { ref, sku }] of variantsByNum(products)) numByKey.set(lineKey({ ref, sku }), num)
  const bytes: number[] = []
  for (const l of lines) {
    const num = numByKey.get(lineKey(l))
    if (num === undefined) continue
    writeVarint(bytes, num)
    writeVarint(bytes, l.qty)
  }
  return toBase64Url(bytes)
}

/** What a slug holds: its lines, and how many of them name a variant the catalogue doesn't have. */
export interface DecodedPlan {
  lines: PlanLine[]
  unknown: number
}

/** The inverse. Null when the slug isn't one we made. */
export function decodePlan(slug: string, products: Iterable<Product>): DecodedPlan | null {
  if (slug === '' || slug.length > MAX_SLUG || !/^[A-Za-z0-9_-]+$/.test(slug)) return null
  let bytes: number[]
  try {
    bytes = fromBase64Url(slug)
  } catch {
    return null
  }
  const byNum = variantsByNum(products)
  const seen = new Set<string>()
  const lines: PlanLine[] = []
  let unknown = 0
  for (let at = 0; at < bytes.length; ) {
    const num = readVarint(bytes, at)
    const qty = num && readVarint(bytes, num.next)
    if (!num || !qty || num.value < 1 || qty.value < 1 || qty.value > MAX_QTY) return null
    at = qty.next
    const target = byNum.get(num.value)
    if (!target) {
      unknown++
      continue
    }
    const line: PlanLine = { ...target, qty: qty.value, addedCents: null }
    if (seen.has(lineKey(line))) continue
    seen.add(lineKey(line))
    lines.push(line)
    if (lines.length + unknown >= MAX_LINES) break
  }
  return { lines, unknown }
}

/** Adds a line, or raises the quantity of the one already there. */
export function addLine(plan: PlanLine[], line: PlanLine): PlanLine[] {
  const same = plan.find((l) => lineKey(l) === lineKey(line))
  if (same) return plan.map((l) => (l === same ? { ...l, qty: Math.min(MAX_QTY, l.qty + line.qty) } : l))
  return plan.length >= MAX_LINES ? plan : [...plan, line]
}

export const removeLine = (plan: PlanLine[], key: string): PlanLine[] => plan.filter((l) => lineKey(l) !== key)

/** Sets a quantity, clamped to 1..MAX_QTY. */
export const setQty = (plan: PlanLine[], key: string, qty: number): PlanLine[] =>
  plan.map((l) => (lineKey(l) === key ? { ...l, qty: Math.min(MAX_QTY, Math.max(1, Math.round(qty) || 1)) } : l))

/** Switches a line to another variant of the same product, merging with a line that already has it. */
export function changeVariant(plan: PlanLine[], key: string, variant: Variant): PlanLine[] {
  const line = plan.find((l) => lineKey(l) === key)
  if (!line || variant.sku === line.sku) return plan
  const moved: PlanLine = { ...line, sku: variant.sku, addedCents: totalCents(variant) }
  return addLine(removeLine(plan, key), moved)
}

/** What to add when someone says "add this product": the cheapest variant in stock, else the cheapest, else the first. */
export function defaultVariant(p: Product): Variant | undefined {
  const cheapest = (vs: Variant[]) => vs.filter((v) => totalCents(v) !== null).sort((a, b) => totalCents(a)! - totalCents(b)!)[0]
  return cheapest(p.variants.filter((v) => v.status === 'Available')) ?? cheapest(p.variants) ?? p.variants[0]
}

export function lineFor(p: Product, qty = 1): PlanLine | null {
  const v = defaultVariant(p)
  return v ? { ref: productRef(p), sku: v.sku, qty, addedCents: totalCents(v) } : null
}

// ---- Pricing a plan against the current catalogue ----

export type LineState = 'in' | 'soon' | 'out' | 'unlisted' | 'untracked'

/** A line with what the catalogue says about it now. */
export interface LineView {
  line: PlanLine
  product?: Product
  variant?: Variant
  /** One's out-the-door price now; null when none is shown. */
  unitCents: number | null
  totalCents: number | null
  currency: string
  /** 'unlisted': the product is tracked but no longer has this variant. 'untracked': the product isn't tracked. */
  state: LineState
  /** The price when the line was added, when it has changed since. */
  wasCents: number | null
}

export function viewLine(line: PlanLine, products: Map<string, Product>): LineView {
  const product = products.get(line.ref)
  const variant = product?.variants.find((v) => v.sku === line.sku)
  const unitCents = variant ? totalCents(variant) : null
  const state: LineState = !product ? 'untracked' : !variant ? 'unlisted' : variant.status === 'Available' ? 'in' : variant.status === 'ComingSoon' ? 'soon' : 'out'
  return {
    line,
    product,
    variant,
    unitCents,
    totalCents: unitCents === null ? null : unitCents * line.qty,
    currency: variant?.currency ?? 'USD',
    state,
    wasCents: line.addedCents !== null && unitCents !== null && line.addedCents !== unitCents ? line.addedCents : null,
  }
}

export interface PlanTotals {
  /** Per currency, since products from different regions can be priced differently. */
  sums: { currency: string; cents: number }[]
  /** Lines with no price to add up. */
  unpriced: number
  items: number
  /** Lines that can't be bought right now. */
  notInStock: LineView[]
}

export function planTotals(views: LineView[]): PlanTotals {
  const sums = new Map<string, number>()
  for (const v of views) if (v.totalCents !== null) sums.set(v.currency, (sums.get(v.currency) ?? 0) + v.totalCents)
  return {
    sums: [...sums].map(([currency, cents]) => ({ currency, cents })),
    unpriced: views.filter((v) => v.totalCents === null).length,
    items: views.reduce((n, v) => n + v.line.qty, 0),
    notInStock: views.filter((v) => v.state !== 'in'),
  }
}
