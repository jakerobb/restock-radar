import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { historyResponse, product, productsResponse, variant } from './test/fixtures'
import { renderWithClient, stubFetch } from './test/render'

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('App', () => {
  it('shows products with grouped variants, the last sync time, and pending items', async () => {
    stubFetch({
      'GET /v1/history?days=90': { body: historyResponse() },
      'GET /v1/products': {
        body: productsResponse({
          products: [
            product({ id: 'p1', title: 'Camera G6', variants: [variant({ id: 'a', title: 'Black' }), variant({ id: 'b', title: 'White' })] }),
            product({ id: 'p2', title: 'Gateway', variants: [variant({ id: 'c', title: 'Default', sku: 'UCG-Fiber', status: 'SoldOut' })] }),
          ],
          pending: [{ region: 'us', slug: 'waiting-slug' }],
        }),
      },
    })
    renderWithClient(<App />)

    expect(await screen.findByRole('heading', { name: /Camera G6/ })).toBeInTheDocument()
    expect(screen.getByText(/Last synced/)).toBeInTheDocument()
    expect(screen.getByText(/2 products/)).toBeInTheDocument()
    expect(screen.getByText('UCG-Fiber')).toBeInTheDocument()
    expect(screen.getByText('us/waiting-slug')).toBeInTheDocument()
  })

  it('says so before the first sync', async () => {
    stubFetch({ 'GET /v1/history?days=90': { body: historyResponse() }, 'GET /v1/products': { body: productsResponse({ last_sync: null, products: [] }) } })
    renderWithClient(<App />)
    expect(await screen.findByText(/Not synced yet/)).toBeInTheDocument()
    expect(screen.getByText(/No products tracked yet/)).toBeInTheDocument()
  })

  it('offers a retry when the API is down', async () => {
    stubFetch({ 'GET /v1/products': { status: 500, body: { error: 'boom' } } })
    renderWithClient(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load products.")
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  describe('history range', () => {
    const routes = () => ({
      'GET /v1/products': { body: productsResponse({ products: [product({ id: 'p1', title: 'Camera G6' })] }) },
      'GET /v1/history?days=7': { body: historyResponse() },
      'GET /v1/history?days=30': { body: historyResponse() },
      'GET /v1/history?days=90': { body: historyResponse() },
      'GET /v1/history?days=365': { body: historyResponse() },
    })
    const historyCalls = (calls: { key: string }[]) => calls.map((c) => c.key).filter((k) => k.includes('/v1/history'))

    it('defaults to 90 days', async () => {
      const calls = stubFetch(routes())
      renderWithClient(<App />)
      await screen.findByRole('heading', { name: /Camera G6/ })
      expect(screen.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true')
      expect(historyCalls(calls)).toEqual(['GET /v1/history?days=90'])
    })

    it('switches range in place and remembers it', async () => {
      const calls = stubFetch(routes())
      renderWithClient(<App />)
      await screen.findByRole('heading', { name: /Camera G6/ })

      await userEvent.click(screen.getByRole('button', { name: '7 days' }))

      expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'false')
      await waitFor(() => expect(historyCalls(calls)).toContain('GET /v1/history?days=7'))
      expect(screen.getByRole('heading', { name: /Camera G6/ })).toBeInTheDocument()
      expect(window.localStorage.getItem('restock-radar.history-days')).toBe('7')
    })

    it('starts on the remembered range', async () => {
      window.localStorage.setItem('restock-radar.history-days', '365')
      const calls = stubFetch(routes())
      renderWithClient(<App />)
      await screen.findByRole('heading', { name: /Camera G6/ })
      expect(screen.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'true')
      expect(historyCalls(calls)).toEqual(['GET /v1/history?days=365'])
    })
  })

  it('filters by tag, combining tags and clearing them', async () => {
    stubFetch({
      'GET /v1/history?days=90': { body: historyResponse() },
      'GET /v1/products': {
        body: productsResponse({
          products: [
            product({ id: 'p1', title: 'AI Port', tags: ['black-friday', 'feature:color-black'] }),
            product({ id: 'p2', title: 'Dome Camera', tags: ['feature:color-black'] }),
            product({ id: 'p3', title: 'Plain Switch', tags: [] }),
            product({ id: 'p4', title: 'Sale Hub', tags: ['black-friday'] }),
          ],
        }),
      },
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByRole('heading', { name: /AI Port/ })

    const tags = screen.getByRole('group', { name: 'Filter by tag' })
    expect(tags).toHaveTextContent('black-friday')
    expect(tags).toHaveTextContent('feature')

    // Prefixed tags sit behind one chip per prefix, which pops up checkboxes.
    expect(screen.queryByRole('checkbox', { name: /color-black/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^feature/ }))
    await user.click(screen.getByRole('checkbox', { name: /^color-black/ }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('checkbox', { name: /color-black/ })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Dome Camera/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Plain Switch/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^black-friday/ }))
    expect(screen.getByRole('heading', { name: /AI Port/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Dome Camera/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Sale Hub/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Clear 2 tags/ }))
    expect(screen.getByRole('heading', { name: /Plain Switch/ })).toBeInTheDocument()
  })

  it('collapses a long tag list but keeps chosen tags visible, and searches it', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag-${String(i).padStart(2, '0')}`)
    stubFetch({
      'GET /v1/history?days=90': { body: historyResponse() },
      'GET /v1/products': { body: productsResponse({ products: [product({ id: 'p1', title: 'Gadget', tags: [...many, 'black-friday'] }), product({ id: 'p2', title: 'Gizmo', tags: [...many, 'black-friday'] })] }) },
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByRole('heading', { name: /Gadget/ })

    const toggle = screen.getByRole('button', { name: /Tags/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /^black-friday/ })).toBeInTheDocument()

    await user.click(toggle) // collapse: nothing chosen, so no chips
    expect(screen.queryByRole('button', { name: /^black-friday/ })).not.toBeInTheDocument()
    await user.click(toggle)
    await user.type(screen.getByRole('searchbox', { name: 'Search tags' }), 'black')
    await user.click(screen.getByRole('button', { name: /^black-friday/ }))
    expect(screen.queryByRole('button', { name: /^tag-01/ })).not.toBeInTheDocument()

    await user.click(toggle) // collapse again: the chosen tag stays
    expect(screen.getByRole('button', { name: /^black-friday/ })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('single-product tags', () => {
  it('are hidden from the tag filter', async () => {
    stubFetch({
      'GET /v1/history?days=90': { body: historyResponse() },
      'GET /v1/products': {
        body: productsResponse({
          products: [
            product({ id: 'p1', title: 'AI Port', tags: ['shared', 'lonely'] }),
            product({ id: 'p2', title: 'Dome Camera', tags: ['shared'] }),
          ],
        }),
      },
    })
    renderWithClient(<App />)
    await screen.findByRole('heading', { name: /AI Port/ })
    const tags = screen.getByRole('group', { name: 'Filter by tag' })
    expect(tags).toHaveTextContent('shared')
    expect(tags).not.toHaveTextContent('lonely')
  })
})

describe('filter column toggle', () => {
  it('shows and hides the filter column', async () => {
    localStorage.clear()
    stubFetch({
      'GET /v1/history?days=90': { body: historyResponse() },
      'GET /v1/products': { body: productsResponse({ products: [product({ id: 'p1', title: 'AI Port' })] }) },
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByRole('heading', { name: /AI Port/ })
    const toggle = screen.getByRole('button', { name: /Hide filters/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    expect(screen.getByRole('button', { name: /Show filters/ })).toHaveAttribute('aria-expanded', 'false')
    localStorage.clear()
  })
})

describe('tag counts', () => {
  it('follow the search, type and in-stock filters', async () => {
    stubFetch({
      'GET /v1/history?days=90': { body: historyResponse() },
      'GET /v1/products': {
        body: productsResponse({
          products: [
            product({ id: 'p1', title: 'Alpha', tags: ['sale', 'feature:4k', 'feature:poe'] }),
            product({ id: 'p2', title: 'Alpha Two', tags: ['sale', 'feature:4k'] }),
            product({ id: 'p3', title: 'Beta', tags: ['sale', 'feature:poe'] }),
          ],
        }),
      },
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByRole('heading', { name: /Alpha Two/ })
    expect(screen.getByRole('button', { name: /^sale 3/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^feature 3/ })).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search products and variants' }), 'beta')
    expect(screen.getByRole('button', { name: /^sale 1/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^feature 1/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^feature/ }))
    expect(screen.getByRole('checkbox', { name: /^poe\s*1/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /^4k\s*0/ })).toBeInTheDocument()
  })
})

describe('type counts', () => {
  it('follow the search and other filters', async () => {
    stubFetch({
      'GET /v1/history?days=90': { body: historyResponse() },
      'GET /v1/products': {
        body: productsResponse({
          products: [
            product({ id: 'p1', title: 'Alpha Cam', type: 'Cameras' }),
            product({ id: 'p2', title: 'Alpha Hub', type: 'Gateways' }),
            product({ id: 'p3', title: 'Beta Hub', type: 'Gateways' }),
          ],
        }),
      },
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByRole('heading', { name: /Alpha Cam/ })
    expect(screen.getByRole('button', { name: /^All\s*3/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Gateways\s*2/ })).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search products and variants' }), 'alpha')
    expect(screen.getByRole('button', { name: /^All\s*2/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Gateways\s*1/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Cameras\s*1/ })).toBeInTheDocument()

    // Choosing a type doesn't change the counts of the others.
    await user.click(screen.getByRole('button', { name: /^Gateways/ }))
    expect(screen.getByRole('button', { name: /^Cameras\s*1/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^All\s*2/ })).toBeInTheDocument()
  })
})
