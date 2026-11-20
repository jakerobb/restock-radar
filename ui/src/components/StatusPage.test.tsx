import { screen, within } from '@testing-library/react'
import type { StatusResponse } from '../api/types'
import { renderWithClient, stubFetch } from '../test/render'
import StatusPage, { every } from './StatusPage'

afterEach(() => vi.unstubAllGlobals())

const status = (overrides: Partial<StatusResponse> = {}): StatusResponse => ({
  now: '2026-11-15T12:00:00Z',
  products: 42,
  variants: 60,
  last_sync: '2026-11-15T11:50:00Z',
  oldest_check: '2026-11-15T09:00:00Z',
  last_poll: null,
  regions: { us: 42 },
  by_region: [],
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

describe('the per-region breakdown', () => {
  const region = (over: Partial<StatusResponse['by_region'][number]>) => ({
    region: 'us',
    products: 30,
    variants: 40,
    in_stock: 25,
    categories: 7,
    last_check: '2026-11-15T11:58:00Z',
    oldest_check: '2026-11-15T11:50:00Z',
    read_every_seconds: 300,
    overdue_after_seconds: 900,
    overdue_variants: 0,
    ...over,
  })

  it('has a row for each region with how often it is read, and says what is overdue', async () => {
    stubFetch({
      'GET /v1/status': {
        body: status({
          regions: { us: 30, eu: 12 },
          by_region: [region({}), region({ region: 'eu', products: 12, variants: 15, in_stock: 9, read_every_seconds: 3600, overdue_after_seconds: 10800, overdue_variants: 4 })],
        }),
      },
    })
    renderWithClient(<StatusPage />)
    const card = await screen.findByRole('region', { name: 'Regions' })
    const us = within(within(card).getByRole('rowheader', { name: 'United States' }).closest('tr')!)
    const eu = within(within(card).getByRole('rowheader', { name: 'Europe' }).closest('tr')!)
    expect(us.getByText('5 minutes')).toBeInTheDocument()
    expect(us.queryByText(/overdue/)).not.toBeInTheDocument()
    expect(eu.getByText('1 hour')).toBeInTheDocument()
    expect(eu.getByText('4 overdue (over 3 hours)')).toBeInTheDocument()
  })

  it('is left out when there is only one region', async () => {
    stubFetch({ 'GET /v1/status': { body: status({ by_region: [region({})] }) } })
    renderWithClient(<StatusPage />)
    await screen.findByRole('region', { name: 'Overview' })
    expect(screen.queryByRole('region', { name: 'Regions' })).not.toBeInTheDocument()
  })

  it('has no region dropdown, since every region is on the page', async () => {
    stubFetch({ 'GET /v1/status': { body: status({ regions: { us: 30, eu: 12 }, by_region: [region({}), region({ region: 'eu' })] }) } })
    renderWithClient(<StatusPage />)
    await screen.findByRole('region', { name: 'Regions' })
    expect(screen.queryByRole('combobox', { name: 'Store region' })).not.toBeInTheDocument()
  })

  it('says how often in plain words', () => {
    expect([60, 300, 3600, 7200, 90].map(every)).toEqual(['1 minute', '5 minutes', '1 hour', '2 hours', '90 seconds'])
  })
})
