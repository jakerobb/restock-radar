import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RefreshResult } from '../api/types'
import { describeRefresh } from './RefreshButton'
import { derived, historyResponse, product, productsResponse } from '../test/fixtures'
import { renderRoute, stubFetch } from '../test/render'

const result = (o: Partial<RefreshResult> = {}): RefreshResult => ({ region: 'us', slug: 'widget', title: 'Widget', variants: 1, spec_entries: 12, specs_changed: false, events: 0, ...o })

const specs = () => ({ region: 'us', id: 'p1', slug: 'widget', title: 'Widget', category: '', specs: [], overrides: [], derived: derived() })

const routes = (refresh: { status?: number; body: unknown }) => ({
  'GET /v1/products': { body: productsResponse({ products: [product({ slug: 'widget', title: 'Widget' })] }) },
  'GET /v1/products/us/widget/specs': { body: specs() },
  'GET /v1/history?days=90': { body: historyResponse() },
  'POST /v1/products/us/widget/refresh': refresh,
})

describe('describeRefresh', () => {
  it.each<[Partial<RefreshResult>, string]>([
    [{}, 'Refreshed. The specification is unchanged.'],
    [{ specs_changed: true }, 'Refreshed. The specification changed.'],
    [{ spec_entries: 0 }, "Refreshed. The store doesn't publish a specification for it yet."],
    [{ events: 1 }, 'Refreshed. The specification is unchanged. 1 price or stock change recorded; notifications go out with the next poll.'],
    [{ events: 3, specs_changed: true }, 'Refreshed. The specification changed. 3 price or stock changes recorded; notifications go out with the next poll.'],
  ])('%j', (o, text) => {
    expect(describeRefresh(result(o))).toBe(text)
  })
})

describe('the Refresh button on the product page', () => {
  it('asks the server to refresh this product, says what it found, and reads the product again', async () => {
    const calls = stubFetch(routes({ body: result({ specs_changed: true }) }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    await user.click(await screen.findByRole('button', { name: 'Refresh from store' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Refreshed. The specification changed.')
    const keys = calls.map((c) => c.key)
    expect(keys.filter((k) => k === 'POST /v1/products/us/widget/refresh')).toHaveLength(1)
    // What was read before is read again: the product list and its specification.
    await waitFor(() => {
      expect(keys.filter((k) => k === 'GET /v1/products').length).toBeGreaterThan(1)
      expect(keys.filter((k) => k === 'GET /v1/products/us/widget/specs').length).toBeGreaterThan(1)
    })
  })

  it('shows the server’s message when the refresh fails, and can be tried again', async () => {
    stubFetch(routes({ status: 429, body: { error: 'too many refreshes in the last minute; wait a moment and try again' } }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    await user.click(await screen.findByRole('button', { name: 'Refresh from store' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('too many refreshes in the last minute')
    expect(screen.getByRole('button', { name: 'Refresh from store' })).toBeEnabled()
  })

  it('is disabled while the refresh is under way, so it can’t be sent twice', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    stubFetch(routes({ body: result() }))
    const real = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') await gate
      return real(input, init)
    })
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    await user.click(await screen.findByRole('button', { name: 'Refresh from store' }))
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled()

    release()
    expect(await screen.findByRole('status')).toHaveTextContent('Refreshed.')
    expect(screen.getByRole('button', { name: 'Refresh from store' })).toBeEnabled()
  })
})
