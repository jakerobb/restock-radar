import { screen, within } from '@testing-library/react'
import type { StatusResponse } from '../api/types'
import { renderWithClient, stubFetch } from '../test/render'
import StatusPage from './StatusPage'

afterEach(() => vi.unstubAllGlobals())

const status = (overrides: Partial<StatusResponse> = {}): StatusResponse => ({
  now: '2026-11-15T12:00:00Z',
  products: 42,
  variants: 60,
  last_sync: '2026-11-15T11:50:00Z',
  oldest_check: '2026-11-15T09:00:00Z',
  last_poll: null,
  regions: { us: 42 },
  categories: [
    { region: 'us', id: 'switching-enterprise', products: 30 },
    { region: 'us', id: 'cameras', products: 12 },
  ],
  uncategorized: 0,
  specs: { with: 10, without: 32, not_checked: 30 },
  techspecs_url: { with: 40, without: 2, not_checked: 0 },
  never_detailed: 5,
  variants_by_status: { Available: 50, SoldOut: 10 },
  watched_from_config: 3,
  watched_from_ui: 1,
  pending_items: 0,
  events_24h: 4,
  events_7d: 20,
  pending_events: 0,
  failed_events: 0,
  latest_event: null,
  db_bytes: 2048,
  ...overrides,
})

describe('StatusPage', () => {
  it('shows totals, categories with counts, and the specs and techspecs splits', async () => {
    stubFetch({ 'GET /v1/status': { body: status() } })
    renderWithClient(<StatusPage />)

    const overview = await screen.findByRole('region', { name: 'Overview' })
    expect(within(overview).getByText('42')).toBeInTheDocument()
    expect(overview.querySelector('time')).toHaveAttribute('datetime', '2026-11-15T11:50:00Z')

    const categories = screen.getByRole('region', { name: 'Categories' })
    expect(within(categories).getByText('switching enterprise')).toBeInTheDocument()
    expect(within(categories).getByText('30')).toBeInTheDocument()
    expect(within(categories).getByText('12')).toBeInTheDocument()

    const specs = screen.getByRole('region', { name: 'Tech specs collected' })
    expect(within(specs).getByText('With specs').nextSibling).toHaveTextContent('10')
    expect(within(specs).getByText('Without specs').nextSibling).toHaveTextContent('32')
    expect(within(specs).getByText('30 not fetched yet')).toBeInTheDocument()

    const url = screen.getByRole('region', { name: 'techspecs.ui.com page' })
    expect(within(url).getByText('With URL').nextSibling).toHaveTextContent('40')
    expect(within(url).getByText('Without URL').nextSibling).toHaveTextContent('2')
  })

  it('says so when nothing has synced or been enrolled', async () => {
    stubFetch({
      'GET /v1/status': { body: status({ products: 0, last_sync: null, categories: [], regions: {}, variants_by_status: {}, db_bytes: null }) },
    })
    renderWithClient(<StatusPage />)
    expect(await screen.findByText('No categories enrolled yet.')).toBeInTheDocument()
    expect(screen.getAllByText('never').length).toBeGreaterThan(0)
  })

  it('offers a retry when the API is down', async () => {
    stubFetch({ 'GET /v1/status': { status: 500, body: { error: 'boom' } } })
    renderWithClient(<StatusPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the status.")
  })
})
