import source from './bookmarklet.js?raw'
import type { LineView } from '../plan'

/**
 * Adding a plan to the store's cart. The page can't do it (the store is another origin, and its cart belongs to the visitor's
 * session), so it hands the plan to a bookmarklet (`./bookmarklet.js`) the owner has run on the store's own page. See
 * DESIGN.md, "Adding a plan to the store's cart".
 */

/** The shape of the plan the bookmarklet reads; it refuses a plan newer than itself, which is how an old bookmark is told to be replaced. */
export const PLAN_FORMAT = 1

/** One product the plan wants, in the store's terms. */
export interface CartItem {
  /** The store's own id for the variant (`storeProductVariantId`), which is the `id` we keep for it. */
  id: string
  sku: string
  /** What it is, for this page's list; the bookmarklet shows the SKU. */
  title: string
  qty: number
}

/** A store's share of a plan: the cart is the visitor's at that store alone, and its ids belong to it. */
export interface StoreCart {
  region: string
  /** Where to open the store: its origin and locale path, as the products' own links have them ("https://eu.store.ui.com", "eu/en"). */
  origin: string
  path: string
  items: CartItem[]
  /** Plan lines that can't go in a cart now, with why. */
  skipped: { title: string; why: string }[]
}

/** What the store's ids look like, and what the bookmarklet insists on. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const WHY: Partial<Record<LineView['state'], string>> = {
  soon: 'not on sale yet',
  out: 'sold out',
  unlisted: 'no longer listed',
  untracked: 'no longer tracked',
}

/** Splits a plan into one cart for each store it buys from, leaving out what the store would refuse (and saying so). */
export function storeCarts(views: LineView[]): StoreCart[] {
  const carts = new Map<string, StoreCart>()
  for (const v of views) {
    const region = v.product?.region ?? v.line.ref.split('/')[0] ?? ''
    if (region === '') continue
    let cart = carts.get(region)
    if (!cart) {
      const where = storeWhere(v.product?.url)
      cart = { region, origin: where?.origin ?? '', path: where?.path ?? '', items: [], skipped: [] }
      carts.set(region, cart)
    }
    if (!cart.origin && v.product?.url) Object.assign(cart, storeWhere(v.product.url))
    const title = v.variant ? `${v.product?.title ?? v.line.sku}${v.variant.title && v.variant.title !== v.product?.title ? ` (${v.variant.title})` : ''}` : (v.product?.title ?? v.line.sku)
    if (v.state === 'in' && v.variant && UUID.test(v.variant.id)) {
      cart.items.push({ id: v.variant.id, sku: v.variant.sku, title, qty: v.line.qty })
    } else {
      cart.skipped.push({ title, why: WHY[v.state] ?? 'not available' })
    }
  }
  return [...carts.values()].sort((a, b) => a.region.localeCompare(b.region))
}

/** The store's origin and locale path from one of its product links ("https://store.ui.com/us/en/category/x/products/y"). */
function storeWhere(url: string | undefined): { origin: string; path: string } | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const [region, language] = u.pathname.split('/').filter(Boolean)
    if (!region || !language) return null
    return { origin: u.origin, path: `${region}/${language}` }
  } catch {
    return null
  }
}

/** The plan as the bookmarklet reads it: compact JSON, safe to carry in a URL fragment or the clipboard. The region lets it refuse a store that isn't the plan's. */
export function cartPayload(name: string, region: string, items: CartItem[]): string {
  return JSON.stringify({ v: PLAN_FORMAT, n: name, r: region, i: items.map((it) => [it.id, it.sku, it.qty]) })
}

/** The store page to open with the plan attached: any page works, the bookmarklet only reads the fragment. */
export function storeUrl(cart: StoreCart, name: string): string | null {
  if (!cart.origin || !cart.path) return null
  return `${cart.origin}/${cart.path}#rr=${encodeURIComponent(cartPayload(name, cart.region, cart.items))}`
}

/** The bookmarklet's source with its comments and indentation taken out, which is all the minifying it needs (see its header). */
export function bookmarkletSource(): string {
  return source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//'))
    .join(' ')
}

/**
 * The link to drag to the bookmarks bar. The `void` is not decoration: a `javascript:` URL that ends in a value makes the browser
 * show that value as the page.
 */
export function bookmarkletHref(): string {
  return `javascript:${encodeURIComponent(`void ${bookmarkletSource()}`)}`
}
