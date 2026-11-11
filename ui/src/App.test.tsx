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
          ],
        }),
      },
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByRole('heading', { name: /AI Port/ })

    const tags = screen.getByRole('group', { name: 'Filter by tag' })
    expect(tags).toHaveTextContent('black-friday')
    expect(tags).toHaveTextContent('feature:color-black')

    await user.click(screen.getByRole('button', { name: /^feature:color-black/ }))
    expect(screen.getByRole('heading', { name: /Dome Camera/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Plain Switch/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^black-friday/ }))
    expect(screen.getByRole('heading', { name: /AI Port/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Dome Camera/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Clear 2 tags/ }))
    expect(screen.getByRole('heading', { name: /Plain Switch/ })).toBeInTheDocument()
  })

  it('collapses a long tag list but keeps chosen tags visible, and searches it', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag-${String(i).padStart(2, '0')}`)
    stubFetch({
      'GET /v1/history?days=90': { body: historyResponse() },
      'GET /v1/products': { body: productsResponse({ products: [product({ id: 'p1', title: 'Gadget', tags: [...many, 'black-friday'] })] }) },
    })
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByRole('heading', { name: /Gadget/ })

    const toggle = screen.getByRole('button', { name: /Tags/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /^black-friday/ })).not.toBeInTheDocument()

    await user.click(toggle)
    await user.type(screen.getByRole('searchbox', { name: 'Search tags' }), 'black')
    await user.click(screen.getByRole('button', { name: /^black-friday/ }))
    expect(screen.queryByRole('button', { name: /^tag-01/ })).not.toBeInTheDocument()

    await user.click(toggle) // collapse again: the chosen tag stays
    expect(screen.getByRole('button', { name: /^black-friday/ })).toHaveAttribute('aria-pressed', 'true')
  })
})
