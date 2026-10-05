import { screen } from '@testing-library/react'
import App from './App'
import { product, productsResponse, variant } from './test/fixtures'
import { renderWithClient, stubFetch } from './test/render'

afterEach(() => vi.unstubAllGlobals())

describe('App', () => {
  it('shows products with grouped variants, the last sync time, and pending items', async () => {
    stubFetch({
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
    stubFetch({ 'GET /v1/products': { body: productsResponse({ last_sync: null, products: [] }) } })
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
})
