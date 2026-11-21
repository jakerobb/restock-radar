import type { Product, UnifiDeviceInfo, Variant } from '../../api/types'
import { productRef } from '../compare'
import { baseSku } from '../convertPlan'
import { totalCents } from '../format'
import { defaultVariant, MAX_QTY, type PlanLine } from '../plan'
import type { FoundDevice } from './types'

/** What became of the devices of one kind. */
export type ImportState =
  /** They are a product this store sells, and tracked here. */
  | 'matched'
  /** Ubiquiti knows what they are, but the store here doesn't list that product (it may be discontinued, or not sold in this region). */
  | 'not-tracked'
  /** Nothing says what they are, or more than one thing does. */
  | 'unknown'

export interface ImportRow {
  /** A line's key for a match; the model code for the rest. */
  id: string
  /** How many devices. */
  count: number
  /** The product's title when matched, else Ubiquiti's name for the device, else its model code. */
  title: string
  state: ImportState
  /** The model codes that came to this row. */
  models: string[]
  line?: PlanLine
  variant?: Variant
}

/** Letters and digits only, lower case: "USW-Pro-HD-24-PoE" and "usw-pro-hd-24-poe" are the same name. */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const unique = (infos: UnifiDeviceInfo[]): UnifiDeviceInfo[] => [...new Map(infos.map((i) => [i.sku, i])).values()]

/** Ubiquiti's lists of devices, by each code that can name them. */
function indexDevices(infos: UnifiDeviceInfo[]) {
  const byName = new Map<string, UnifiDeviceInfo[]>()
  const bySysid = new Map<string, UnifiDeviceInfo[]>()
  const add = (m: Map<string, UnifiDeviceInfo[]>, k: string, i: UnifiDeviceInfo) => m.set(k, [...(m.get(k) ?? []), i])
  for (const i of infos) {
    for (const n of i.shortnames) add(byName, n.toLowerCase(), i)
    for (const id of i.sysids) add(bySysid, id.toLowerCase(), i)
  }
  return { byName, bySysid }
}

/**
 * What Ubiquiti says a device is. A model code is one of the names the list gives a device (the older ones, "USMINI"); the
 * short name a support file gives is another; and the newer codes end in the device's system id ("UAPA6A4" is a6a4).
 * Each is tried in that order, and the first to name exactly one device decides.
 */
function resolve(d: FoundDevice, index: ReturnType<typeof indexDevices>): UnifiDeviceInfo | undefined {
  const suffix = /[0-9a-f]{4}$/i.exec(d.model)?.[0].toLowerCase()
  const tries = [index.byName.get(d.model.toLowerCase()), d.shortname ? index.byName.get(d.shortname.toLowerCase()) : undefined, d.sysid ? index.bySysid.get(d.sysid) : undefined, suffix ? index.bySysid.get(suffix) : undefined]
  for (const t of tries) {
    const found = unique(t ?? [])
    if (found.length === 1) return found[0]
  }
  return undefined
}

interface CatalogEntry {
  product: Product
  /** The variants whose SKU gave the match; all of them when the product's slug did. */
  variants: Variant[]
}

/** The products by the names they go by: their slug and each variant's SKU without its region, each reduced by `norm`. */
function indexCatalog(products: Product[]): Map<string, CatalogEntry[]> {
  const index = new Map<string, CatalogEntry[]>()
  const add = (key: string, product: Product, variants: Variant[]) => {
    const list = index.get(key) ?? []
    const have = list.find((e) => e.product === product)
    if (have) have.variants = [...new Set([...have.variants, ...variants])]
    else list.push({ product, variants })
    index.set(key, list)
  }
  for (const p of products) {
    add(norm(p.slug), p, p.variants)
    for (const v of p.variants) add(norm(baseSku(v.sku)), p, [v])
  }
  return index
}

/** The product, and the variant of it, that a device of Ubiquiti's list is: its SKU, or failing that one of its other names. Undefined when none, or when more than one product has the name. */
function findProduct(info: UnifiDeviceInfo, catalog: Map<string, CatalogEntry[]>): { product: Product; variant: Variant } | 'ambiguous' | undefined {
  for (const name of [info.sku, ...info.shortnames.map(baseSku)]) {
    const entries = catalog.get(norm(name))
    if (!entries || entries.length === 0) continue
    if (entries.length > 1) return 'ambiguous'
    const { product, variants } = entries[0]!
    const exact = variants.find((v) => v.sku.toLowerCase() === info.sku.toLowerCase())
    const variant = exact ?? defaultVariant({ ...product, variants })
    return variant ? { product, variant } : undefined
  }
  return undefined
}

/**
 * Turns what a console's file lists into plan lines. `products` are those of the store the plan is for. Devices of one
 * kind are one row with a count; a row is a match, a device the store doesn't carry, or one that couldn't be told.
 * Matches come first, by title.
 */
export function matchDevices(found: FoundDevice[], infos: UnifiDeviceInfo[], products: Product[]): ImportRow[] {
  const devices = indexDevices(infos)
  const catalog = indexCatalog(products)
  const rows = new Map<string, ImportRow>()
  for (const d of found) {
    const info = resolve(d, devices)
    const hit = info ? findProduct(info, catalog) : undefined
    let id: string
    let row: Omit<ImportRow, 'count' | 'models'>
    if (hit && hit !== 'ambiguous') {
      const line: PlanLine = { ref: productRef(hit.product), sku: hit.variant.sku, qty: 1, addedCents: totalCents(hit.variant) }
      id = `${line.ref}:${line.sku}`
      row = { id, title: hit.product.title, state: 'matched', line, variant: hit.variant }
    } else {
      id = `model:${d.model}`
      row = { id, title: info?.name ?? d.model, state: info && hit !== 'ambiguous' ? 'not-tracked' : 'unknown' }
    }
    const have = rows.get(id)
    if (have) {
      have.count++
      if (!have.models.includes(d.model)) have.models.push(d.model)
    } else rows.set(id, { ...row, count: 1, models: [d.model] })
  }
  const state = { matched: 0, 'not-tracked': 1, unknown: 2 }
  return [...rows.values()]
    .map((r) => (r.line ? { ...r, line: { ...r.line, qty: Math.min(r.count, MAX_QTY) } } : r))
    .sort((a, b) => state[a.state] - state[b.state] || a.title.localeCompare(b.title))
}
