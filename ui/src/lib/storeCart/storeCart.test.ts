import { lineFor, viewLine } from '../plan'
import { product, variant } from '../../test/fixtures'
import { cartPayload, storeCarts, storeUrl } from './storeCart'

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const views = (...ps: ReturnType<typeof product>[]) => {
  const map = new Map(ps.map((p) => [`${p.region}/${p.slug}`, p]))
  return ps.flatMap((p) =>
    p.variants.map((v, i) => {
      const line = lineFor(p, i + 1)!
      return viewLine({ ...line, sku: v.sku }, map)
    }),
  )
}

describe('storeCarts', () => {
  it('lists what is in stock, with the store’s variant id, and says why the rest is left out', () => {
    const ap = product({ slug: 'u7-pro', title: 'U7 Pro', url: 'https://store.ui.com/us/en/category/wifi/products/u7-pro', variants: [variant({ id: U(1), sku: 'U7-Pro-US', title: 'U7 Pro' })] })
    const sw = product({
      slug: 'sw',
      title: 'Switch',
      url: 'https://store.ui.com/us/en/category/sw/products/sw',
      variants: [variant({ id: U(2), sku: 'SW-8', title: '8 port', status: 'SoldOut' }), variant({ id: U(3), sku: 'SW-ETA', title: 'ETA', status: 'ComingSoon' })],
    })
    const [cart, ...rest] = storeCarts(views(ap, sw))
    expect(rest).toEqual([])
    expect(cart).toMatchObject({ region: 'us', origin: 'https://store.ui.com', path: 'us/en' })
    expect(cart?.items).toEqual([{ id: U(1), sku: 'U7-Pro-US', title: 'U7 Pro', qty: 1 }])
    expect(cart?.skipped).toEqual([
      { title: 'Switch (8 port)', why: 'sold out' },
      { title: 'Switch (ETA)', why: 'not on sale yet' },
    ])
  })

  it('makes a cart for each store, since each has its own cart and ids', () => {
    const us = product({ region: 'us', slug: 'a', url: 'https://store.ui.com/us/en/products/a', variants: [variant({ id: U(1), sku: 'A' })] })
    const eu = product({ region: 'eu', slug: 'a', url: 'https://eu.store.ui.com/eu/en/products/a', variants: [variant({ id: U(2), sku: 'A-EU', currency: 'EUR' })] })
    const carts = storeCarts(views(us, eu))
    expect(carts.map((c) => [c.region, c.origin, c.path, c.items.map((i) => i.id)])).toEqual([
      ['eu', 'https://eu.store.ui.com', 'eu/en', [U(2)]],
      ['us', 'https://store.ui.com', 'us/en', [U(1)]],
    ])
  })

  it('leaves out a variant whose id isn’t one the store uses, so the bookmark isn’t refused whole', () => {
    const p = product({ variants: [variant({ id: 'v1', sku: 'X' })] })
    const [cart] = storeCarts(views(p))
    expect(cart?.items).toEqual([])
    expect(cart?.skipped).toHaveLength(1)
  })
})

describe('the plan handed over', () => {
  it('is compact, and the store link carries it in the fragment, which is never sent to a server', () => {
    const items = [{ id: U(1), sku: 'U7-Pro-US', title: 'U7 Pro', qty: 2 }]
    expect(JSON.parse(cartPayload('My Plan', 'us', items))).toEqual({ v: 1, n: 'My Plan', r: 'us', i: [[U(1), 'U7-Pro-US', 2]] })
    const url = storeUrl({ region: 'us', origin: 'https://store.ui.com', path: 'us/en', items, skipped: [] }, 'My Plan')!
    expect(url.startsWith('https://store.ui.com/us/en#rr=')).toBe(true)
    expect(JSON.parse(decodeURIComponent(url.split('#rr=')[1]!))).toEqual(JSON.parse(cartPayload('My Plan', 'us', items)))
  })

  it('has no store to open when the product links gave none', () => {
    expect(storeUrl({ region: 'us', origin: '', path: '', items: [], skipped: [] }, 'x')).toBeNull()
  })
})
