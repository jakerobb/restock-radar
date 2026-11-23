import { bookmarkletHref, bookmarkletSource, cartPayload } from './storeCart'

const A = '016bf38c-e845-40c8-8662-32c5e31dc8c1'
const B = 'db134881-a0a6-401f-a206-7fd77cc2fadd'
const C = '5e7617b4-1b55-4495-83f6-add202d04458'

interface Result {
  status: string
  added?: number
  failed?: string[]
}

/** A stand-in for the store's page: the Apollo cache the bookmarklet looks in, and the cart API it calls. */
function fakeStore(opts: { cart?: Record<string, number>; refuse?: string[]; noCheckout?: boolean; locale?: string } = {}) {
  const cart: Record<string, number> = { ...opts.cart }
  const calls: { query: string; input: Record<string, unknown> }[] = []
  const items = () => Object.entries(cart).map(([id, quantity]) => ({ sku: `sku-${id.slice(0, 4)}`, quantity, variant: { id } }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://ecomm.svc.ui.com/graphql')
      expect(init.credentials).toBe('include')
      const { query, variables } = JSON.parse(init.body as string) as { query: string; variables: { input: Record<string, unknown> } }
      calls.push({ query, input: variables.input })
      expect(variables.input).toMatchObject({ id: 'checkout-1', secret: 'shh', language: opts.locale ?? 'en' })
      const reply = (data: unknown) => new Response(JSON.stringify(data))
      if (query.startsWith('mutation')) {
        for (const u of variables.input.updateItems as { storeProductVariantId: string; quantity: number }[]) {
          if (opts.refuse?.includes(u.storeProductVariantId)) return reply({ errors: [{ message: 'Checkout upsert variant not found' }], data: null })
          cart[u.storeProductVariantId] = (cart[u.storeProductVariantId] ?? 0) + u.quantity
        }
        return reply({ data: { storefrontUpdateCheckout: { checkout: { items: items() } } } })
      }
      return reply({ data: { storefrontCheckout: { checkout: { items: items() } } } })
    }),
  )
  const cache = opts.noCheckout
    ? {}
    : {
        'ActiveCheckout:checkout-1': { __typename: 'ActiveCheckout', id: 'checkout-1', secret: 'shh', storeId: 'us' },
        'StorefrontCheckout:checkout-1': { __typename: 'StorefrontCheckout', language: { locale: opts.locale ?? 'en' } },
      }
  vi.stubGlobal('__APOLLO_CLIENT__', { cache: { extract: () => cache } })
  return { cart, calls }
}

const alerts = vi.fn<(message: string) => void>()
const confirms = vi.fn<(message: string) => boolean>(() => true)
const prompts = vi.fn<(message: string) => string>(() => '')
const navigated = vi.fn<(path: string) => void>()

beforeEach(() => {
  alerts.mockReset()
  confirms.mockReset().mockReturnValue(true)
  prompts.mockReset().mockReturnValue('')
  vi.stubGlobal('alert', alerts)
  vi.stubGlobal('confirm', confirms)
  vi.stubGlobal('prompt', prompts)
  navigated.mockReset()
  vi.stubGlobal('__rrGo', navigated)
  history.replaceState(null, '', '/us/en/category/all-wifi/products/u7-pro')
  delete (window as { __rrCart?: boolean }).__rrCart
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const planFragment = (items: [string, string, number][], name = 'Rack', region = 'us') => {
  history.replaceState(null, '', `/us/en#rr=${encodeURIComponent(cartPayload(name, region, items.map(([id, sku, qty]) => ({ id, sku, qty, title: sku }))))}`)
}

/** Runs the bookmarklet as the browser would, from the source that goes into the link. */
const run = () => (0, eval)(bookmarkletSource()) as Promise<Result>
const wentToCart = () => navigated.mock.calls.some(([path]) => path === '/us/en/cart')

describe('the bookmarklet as a link', () => {
  it('is one line of code behind javascript:, with no comments left in it, that evaluates to nothing', () => {
    const href = bookmarkletHref()
    expect(href.startsWith('javascript:')).toBe(true)
    const code = decodeURIComponent(href.slice('javascript:'.length))
    expect(code.startsWith('void (async () => {')).toBe(true)
    expect(code).not.toContain('\n')
    expect(code).not.toMatch(/(^|\s)\/\/ /) // a // comment would swallow the rest of the line
    expect(code.length).toBeLessThan(8000)
    expect(() => new Function(code)).not.toThrow() // it parses
  })
})

describe('the bookmarklet on a store page', () => {
  it('adds each product to the cart in the plan, opens the cart, and says what it did first', async () => {
    const store = fakeStore({ cart: { [C]: 1 } })
    planFragment([[A, 'U7-Pro-US', 2], [B, 'USW-Aggregation', 1]])
    const result = await run()
    expect(result).toMatchObject({ status: 'ok', added: 2 })
    expect(store.cart).toEqual({ [A]: 2, [B]: 1, [C]: 1 }) // what was there stays
    expect(confirms.mock.calls[0]?.[0]).toContain('2 × U7-Pro-US')
    expect(confirms.mock.calls[0]?.[0]).toContain('Rack')
    expect(alerts).not.toHaveBeenCalled()
    expect(wentToCart()).toBe(true)
  })

  it('tops the cart up to the plan, so a second run changes nothing and a partly filled cart gets the difference', async () => {
    const store = fakeStore({ cart: { [A]: 1 } })
    planFragment([[A, 'U7-Pro-US', 3], [B, 'USW-Aggregation', 1]])
    expect(await run()).toMatchObject({ status: 'ok', added: 2 })
    expect(store.cart).toEqual({ [A]: 3, [B]: 1 })
    expect(confirms.mock.calls[0]?.[0]).toContain('2 × U7-Pro-US (1 already in the cart)')

    confirms.mockClear()
    store.calls.length = 0
    expect(await run()).toMatchObject({ status: 'already' })
    expect(store.cart).toEqual({ [A]: 3, [B]: 1 })
    expect(store.calls.every((c) => c.query.startsWith('query'))).toBe(true) // it only looked
    expect(confirms).not.toHaveBeenCalled()
  })

  it('does nothing if the person says no', async () => {
    const store = fakeStore()
    planFragment([[A, 'U7-Pro-US', 1]])
    confirms.mockReturnValue(false)
    expect(await run()).toMatchObject({ status: 'cancelled' })
    expect(store.cart).toEqual({})
    expect(wentToCart()).toBe(false)
  })

  it('carries on past a product the store refuses, and names it', async () => {
    const store = fakeStore({ refuse: [B] })
    planFragment([[B, 'USW-Aggregation', 1], [A, 'U7-Pro-US', 1]])
    const result = await run()
    expect(result).toMatchObject({ status: 'partial', added: 1 })
    expect(result.failed?.[0]).toContain('USW-Aggregation: Checkout upsert variant not found')
    expect(store.cart).toEqual({ [A]: 1 })
    expect(alerts.mock.calls[0]?.[0]).toContain('Added 1 of 2')
    expect(wentToCart()).toBe(true)
  })

  it('asks the store for the language the store uses', async () => {
    const store = fakeStore({ locale: 'ja' })
    planFragment([[A, 'U7-Pro-US', 1]])
    await run()
    expect(store.calls.length).toBeGreaterThan(0) // fakeStore checks each call's language
  })

  it('falls back to the clipboard, then to a paste, when the page has no fragment', async () => {
    const store = fakeStore()
    const plan = cartPayload('Pasted', 'us', [{ id: A, sku: 'U7-Pro-US', title: '', qty: 1 }])
    prompts.mockReturnValue(plan)
    expect(await run()).toMatchObject({ status: 'ok' }) // no clipboard in jsdom, so it asks
    expect(prompts).toHaveBeenCalledTimes(1)
    expect(store.cart).toEqual({ [A]: 1 })

    vi.stubGlobal('navigator', { clipboard: { readText: async () => plan } })
    prompts.mockClear()
    store.cart[A] = 0
    expect(await run()).toMatchObject({ status: 'ok' })
    expect(prompts).not.toHaveBeenCalled()
    expect(store.cart[A]).toBe(1)
  })

  it('refuses another region’s plan before touching the cart, and says which stores', async () => {
    const store = fakeStore()
    planFragment([[A, 'U7-Pro-EU', 1]], 'Rack', 'eu') // the page is the US store
    expect(await run()).toMatchObject({ status: 'wrong-store' })
    expect(alerts.mock.calls[0]?.[0]).toContain('plan is for the EU store, but you are on the US store')
    expect(store.calls).toEqual([])
    expect(confirms).not.toHaveBeenCalled()
  })

  it('does not check the store for a plan that names no region (from an older plan page)', async () => {
    const store = fakeStore()
    history.replaceState(null, '', `/us/en#rr=${encodeURIComponent(JSON.stringify({ v: 1, n: 'Old', i: [[A, 'U7-Pro-US', 1]] }))}`)
    expect(await run()).toMatchObject({ status: 'ok' })
    expect(store.cart).toEqual({ [A]: 1 })
  })

  it('says so when there is no plan to read', async () => {
    const store = fakeStore()
    expect(await run()).toMatchObject({ status: 'no-plan' })
    expect(alerts.mock.calls[0]?.[0]).toContain('no plan')
    expect(store.calls).toEqual([])
  })

  it.each([
    ['not json', 'nope'],
    ['an id that is not the store’s', JSON.stringify({ v: 1, n: '', i: [['../../etc', 'X', 1]] })],
    ['a quantity of none', JSON.stringify({ v: 1, n: '', i: [[A, 'X', 0]] })],
    ['a quantity of a thousand', JSON.stringify({ v: 1, n: '', i: [[A, 'X', 1000]] })],
    ['no products', JSON.stringify({ v: 1, n: '', i: [] })],
  ])('refuses a plan with %s, touching nothing', async (_, text) => {
    const store = fakeStore()
    history.replaceState(null, '', `/us/en#rr=${encodeURIComponent(text)}`)
    expect(await run()).toMatchObject({ status: 'no-plan' })
    expect(store.calls).toEqual([])
  })

  it('tells the owner to replace a bookmark that is older than the plan page', async () => {
    const store = fakeStore()
    history.replaceState(null, '', `/us/en#rr=${encodeURIComponent(JSON.stringify({ v: 99, n: '', i: [[A, 'X', 1]] }))}`)
    expect(await run()).toMatchObject({ status: 'stale' })
    expect(alerts.mock.calls[0]?.[0]).toContain('older')
    expect(store.calls).toEqual([])
  })

  it('asks for one item to be added first when the store has no cart open yet', async () => {
    const store = fakeStore({ noCheckout: true })
    planFragment([[A, 'U7-Pro-US', 1]])
    expect(await run()).toMatchObject({ status: 'no-cart' })
    expect(alerts.mock.calls[0]?.[0]).toContain('no cart open')
    expect(store.calls).toEqual([])
  })

  it('stops and says so when the store answers in a way it does not know, rather than guessing', async () => {
    fakeStore()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { somethingElse: 1 } }))))
    planFragment([[A, 'U7-Pro-US', 1]])
    expect(await run()).toMatchObject({ status: 'error' })
    expect(alerts.mock.calls[0]?.[0]).toContain('Something went wrong')
    expect(wentToCart()).toBe(false)
  })

  it('does not run twice at once', async () => {
    fakeStore()
    planFragment([[A, 'U7-Pro-US', 1]])
    const first = run()
    expect(await run()).toMatchObject({ status: 'busy' })
    await first
  })
})
