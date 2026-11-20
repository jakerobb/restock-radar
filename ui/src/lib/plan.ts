import type { Product, Variant } from '../api/types'
import { totalCents } from './format'
import type { Powering } from './powering'
import { HOSTED_ROLES, type Hosting } from './roles'
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
/** What a plan is called until it is named. */
export const DEFAULT_PLAN_NAME = 'My Plan'
/** The longest a plan's name can be, in characters; it travels in the share link. */
export const MAX_NAME = 50

/** A name as it is kept: spaces trimmed and collapsed, cut to MAX_NAME characters; empty for anything that isn't a name. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Control characters (a newline pasted in) are spaces; the rest of Unicode is welcome.
  return Array.from(raw.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, MAX_NAME).join('').trim()
}
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
// A shared plan is a slug: its name (UTF-8, after a number that says how long it is), then, for each line, the variant's permanent number (which says which product, in
// which region, and which variant) and the quantity, each as a variable-length integer, in base64url.
// Prices don't travel; whoever opens the link sees today's.

/** Longest slug we'll read; MAX_LINES lines and a name of MAX_NAME characters need well under this. */
export const MAX_SLUG = 900

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

/**
 * Where a controller is run when it isn't a product, in a slug: a number no variant has, above 2^30, for each
 * role that is self-hosted with a quantity of 1 after it, following the lines.
 */
const HOSTING_BASE = 2 ** 30
/**
 * How a switch is powered, in a slug: the number 2^29 plus the variant's, with the scenario's code (from 1) in
 * place of a quantity. Variant numbers are far below 2^29, and hosting begins at 2^30.
 */
const POWER_BASE = 2 ** 29
/**
 * The plan's name, in a slug, first: the number 2^31 plus its length in bytes, then the bytes of its UTF-8. The
 * longest name is MAX_NAME characters of four bytes each.
 */
const NAME_BASE = 2 ** 31
const MAX_NAME_BYTES = MAX_NAME * 4
const hostingNumber = (role: (typeof HOSTED_ROLES)[number]) => HOSTING_BASE + HOSTED_ROLES.indexOf(role) * 2
/** The role a number stands for; null for one that isn't self-hosting (an odd number was cloud hosting, once, before it became a product). */
const hostingOf = (num: number): [(typeof HOSTED_ROLES)[number], 'self'] | 'ignore' | null => {
  const i = num - HOSTING_BASE
  const role = HOSTED_ROLES[Math.floor(i / 2)]
  if (i < 0 || !role) return null
  return i % 2 === 0 ? [role, 'self'] : 'ignore'
}

/** The variants by number: which product (as "region/slug") and which SKU each is. */
export function variantsByNum(products: Iterable<Product>): Map<number, { ref: string; sku: string }> {
  const out = new Map<number, { ref: string; sku: string }>()
  for (const p of products) {
    // Retired first: where one has the SKU of a listed variant, the listed one is the number to give out.
    for (const v of p.retired ?? []) out.set(v.num, { ref: productRef(p), sku: v.sku })
    for (const v of p.variants) out.set(v.num, { ref: productRef(p), sku: v.sku })
  }
  return out
}

/**
 * A plan as a short URL-safe slug. Lines whose variant isn't in the catalogue have no number and
 * are left out, so there may be nothing to share (an empty slug).
 */
export function encodePlan(lines: PlanLine[], products: Iterable<Product>, hosting: Hosting = {}, powering: Powering = {}, name = ''): string {
  const numByKey = new Map<string, number>()
  for (const [num, { ref, sku }] of variantsByNum(products)) numByKey.set(lineKey({ ref, sku }), num)
  const bytes: number[] = []
  const nameBytes = [...new TextEncoder().encode(cleanName(name))]
  if (nameBytes.length > 0) {
    writeVarint(bytes, NAME_BASE + nameBytes.length)
    bytes.push(...nameBytes)
  }
  const namePart = bytes.length
  for (const l of lines) {
    const num = numByKey.get(lineKey(l))
    if (num === undefined) continue
    writeVarint(bytes, num)
    writeVarint(bytes, l.qty)
  }
  for (const l of lines) {
    const num = numByKey.get(lineKey(l))
    const code = powering[lineKey(l)]
    if (num === undefined || code === undefined) continue
    writeVarint(bytes, POWER_BASE + num)
    writeVarint(bytes, code)
  }
  for (const role of HOSTED_ROLES) {
    const where = hosting[role]
    if (!where) continue
    writeVarint(bytes, hostingNumber(role))
    writeVarint(bytes, 1)
  }
  // A name with nothing to go with it isn't worth a link.
  if (bytes.length === namePart) return ''
  return toBase64Url(bytes)
}

/** What a slug holds: its lines, and how many of them name a variant the catalogue doesn't have. */
export interface DecodedPlan {
  /** What it is called; the default when the link doesn't say. */
  name: string
  lines: PlanLine[]
  unknown: number
  /** The controllers it runs elsewhere. */
  hosting: Hosting
  /** How its switches are powered, by line key. */
  powering: Powering
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
  const hosting: Hosting = {}
  const powerEntries: [number, number][] = []
  let unknown = 0
  let name = ''
  for (let at = 0; at < bytes.length; ) {
    const num = readVarint(bytes, at)
    if (num && num.value >= NAME_BASE) {
      const len = num.value - NAME_BASE
      if (at !== 0 || len < 1 || len > MAX_NAME_BYTES || num.next + len > bytes.length) return null
      try {
        name = cleanName(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes.slice(num.next, num.next + len))))
      } catch {
        return null
      }
      at = num.next + len
      continue
    }
    const qty = num && readVarint(bytes, num.next)
    if (num && qty && num.value >= POWER_BASE && num.value < HOSTING_BASE) {
      // How a switch is powered: the code stands where the quantity does. The variant may come later in the slug, so it is resolved after.
      if (qty.value < 1 || qty.value > 0xffff) return null
      powerEntries.push([num.value - POWER_BASE, qty.value])
      at = qty.next
      continue
    }
    if (!num || !qty || num.value < 1 || qty.value < 1 || qty.value > MAX_QTY) return null
    at = qty.next
    const host = hostingOf(num.value)
    if (host) {
      if (host !== 'ignore') hosting[host[0]] = host[1]
      continue
    }
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
  const powering: Powering = {}
  for (const [vnum, code] of powerEntries) {
    const target = byNum.get(vnum)
    if (target && seen.has(lineKey(target))) powering[lineKey(target)] = code
  }
  return { name: name || DEFAULT_PLAN_NAME, lines, unknown, hosting, powering }
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
  // It stays where it was; if the new variant is already in the plan, the two merge into that line.
  const there = plan.find((l) => lineKey(l) === lineKey(moved))
  if (there) return addLine(removeLine(plan, key), moved)
  return plan.map((l) => (l === line ? moved : l))
}

/**
 * Chooses which of a product's linked products (the SSDs sold with a gateway) goes in the plan beside it: the
 * others come out and the chosen one goes in, as many as the product itself, or none to take them all out.
 */
export function setAddOn(plan: PlanLine[], options: Product[], chosen: Product | null, qty: number): PlanLine[] {
  const refs = new Set(options.map(productRef))
  const kept = plan.filter((l) => !refs.has(l.ref) || (chosen !== null && l.ref === productRef(chosen)))
  const line = chosen ? lineFor(chosen, qty) : null
  return line ? addLine(kept.filter((l) => l.ref !== line.ref), line) : kept
}

/** Replaces a line with another product's, where it was (or into the line already in the plan for that product). */
export function replaceLine(plan: PlanLine[], key: string, line: PlanLine): PlanLine[] {
  const old = plan.find((l) => lineKey(l) === key)
  if (!old) return plan
  if (plan.some((l) => lineKey(l) === lineKey(line))) return addLine(removeLine(plan, key), line)
  return plan.map((l) => (l === old ? line : l))
}

/** Makes sure the plan has at least `qty` of a product (one more line, or a bigger quantity on its line), which is what an adapter for each switch needs. */
export function ensureQty(plan: PlanLine[], p: Product, qty: number): PlanLine[] {
  const line = lineFor(p, qty)
  if (!line) return plan
  const have = plan.filter((l) => l.ref === line.ref).reduce((n, l) => n + l.qty, 0)
  return have >= qty ? plan : addLine(plan, { ...line, qty: qty - have })
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
