import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProductSpecsResponse, SpecEntry } from '../api/types'
import { derived, historyResponse, port, product, productsResponse } from '../test/fixtures'
import { renderRoute, stubFetch } from '../test/render'

const entry = (o: Partial<SpecEntry>): SpecEntry => ({ section_id: 'hw', section: 'Hardware', section_type: 'Standard', feature_id: 'f', label: 'Thing', kind: 'text', value: 'x', origin: 'published', ...o })

const specsResponse = (o: Partial<ProductSpecsResponse> = {}): ProductSpecsResponse => ({
  region: 'us',
  id: 'p1',
  slug: 'widget',
  title: 'Widget',
  category: 'switching-professional',
  specs: [
    entry({ label: 'Form Factor', value: 'Rack mount (1U)' }),
    entry({ label: 'IDS/IPS Throughput', value: '8+ Gbps', origin: 'override', published_value: '5 Gbps', stale: true, feature_id: 'g' }),
    entry({ label: 'Teardown finding', value: 'Has a spare header', origin: 'added', feature_id: 'h' }),
    entry({ section_id: 'ov', section: 'Grid overview', section_type: 'Overview', label: 'Repeated', value: 'should not show' }),
  ],
  overrides: [
    {
      id: 7, region: 'us', slug: 'widget', action: 'set', section: 'Hardware', group: '', label: 'IDS/IPS Throughput', kind: 'text', value: '8+ Gbps', note: '',
      source_url: 'https://example.com/teardown', reason: 'Measured in a teardown', status: 'overrides', stale: true, published_now: '6 Gbps',
    },
  ],
  derived: derived({
    known: { ports: true, poe: true, radios: true, rack: true, dims: true },
    ports: [port({ label: '10 GbE RJ45', count: 2, max_speed_mbps: 10000, speeds_mbps: [10000, 1000], poe_class: 'PoE++', poe_direction: 'out', poe_watts: 60 })],
    rack: { mountable: true, units: 1, full_depth: false },
    power: [
      { kind: 'ac', poe_class: '', detail: 'Universal input, 100–240V AC' },
      { kind: 'poe', poe_class: 'PoE+', detail: 'PoE+' },
    ],
    dims: { min_mm: 44, mid_mm: 300, max_mm: 442, round: false },
    metrics: [{ name: 'ids_ips_throughput_mbps', value: 8000, unit: 'Mbps', at_least: true, raw: '8+ Gbps' }],
    overridden: { ports: false, poe_budget: false, radios: false, rack: false, dims: false, metrics: [{ name: 'ids_ips_throughput_mbps', published: { name: 'ids_ips_throughput_mbps', value: 5000, unit: 'Mbps', at_least: false, raw: '5 Gbps' } }] },
  }),
  ...o,
})

describe('ProductPage', () => {
  it('shows the product, what is derived from its specs, and the specification with overrides beside the published value', async () => {
    stubFetch({
      'GET /v1/products': { body: productsResponse({ products: [product({ slug: 'widget', title: 'Widget' })] }) },
      'GET /v1/products/us/widget/specs': { body: specsResponse() },
      'GET /v1/history?days=90': { body: historyResponse() },
    })
    renderRoute('/p/us/widget')

    expect(await screen.findByRole('heading', { level: 1, name: 'Widget' })).toBeInTheDocument()
    const glance = await screen.findByRole('region', { name: 'At a glance' })
    expect(glance).toHaveTextContent('2 × 10 GbE RJ45 (10 GbE / 1 GbE) · PoE++ out, 60 W')
    expect(glance).toHaveTextContent('Rack-mount, 1U')
    expect(glance).toHaveTextContent('Powered by')
    expect(glance).toHaveTextContent('AC · Universal input, 100–240V AC') // the published line, when it says more than the label
    expect(glance).toHaveTextContent('PoE+') // and nothing repeated when it says no more
    expect(glance).toHaveTextContent('44 × 300 × 442 mm')
    expect(glance).toHaveTextContent('IDS/IPS throughput: ≥ 8000 Mbps')
    expect(glance).toHaveTextContent('overridden, published 5000 Mbps')

    const hardware = screen.getByRole('region', { name: 'Hardware' })
    expect(hardware).toHaveTextContent('8+ Gbps')
    expect(hardware).toHaveTextContent('Overridden, published value changed')
    expect(hardware).toHaveTextContent('Published: 5 Gbps')
    expect(hardware).toHaveTextContent('Added')
    // The grid overview repeats other sections, so it isn't shown again.
    expect(screen.queryByText('should not show')).not.toBeInTheDocument()

    const overrides = screen.getByRole('region', { name: 'Overrides' })
    expect(overrides).toHaveTextContent('Measured in a teardown')
    expect(within(overrides).getByRole('link', { name: 'source' })).toHaveAttribute('href', 'https://example.com/teardown')
  })

  it('says so for a product that is not tracked', async () => {
    stubFetch({
      'GET /v1/products': { body: productsResponse({ products: [] }) },
      'GET /v1/products/us/nope/specs': { status: 404, body: { error: 'unknown product' } },
      'GET /v1/history?days=90': { body: historyResponse() },
    })
    renderRoute('/p/us/nope')
    expect(await screen.findByRole('alert')).toHaveTextContent('We aren\'t tracking a product called us/nope')
  })

  it('shows what is known for a product with no specification yet', async () => {
    stubFetch({
      'GET /v1/products': { body: productsResponse({ products: [product({ slug: 'widget', title: 'Widget' })] }) },
      'GET /v1/products/us/widget/specs': { body: specsResponse({ specs: [], overrides: [], derived: null }) },
      'GET /v1/history?days=90': { body: historyResponse() },
    })
    renderRoute('/p/us/widget')
    expect(await screen.findByText('No specification has been collected for this product yet.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'At a glance' })).not.toBeInTheDocument()
  })
})


describe('a product with no tech specs', () => {
  const gaps = (o: object = {}) => ({
    products: [{ region: 'us', id: 'p1', slug: 'widget', title: 'Widget', category: 'accessories', fetched_at: '2026-11-15T10:00:00Z', published: false, not_expected: false }],
    not_expected: [],
    ...o,
  })
  const routes = (g: object) => ({
    'GET /v1/products': { body: productsResponse({ products: [product({ slug: 'widget', title: 'Widget' })] }) },
    'GET /v1/products/us/widget/specs': { body: specsResponse({ specs: [], derived: null, overrides: [] }) },
    'GET /v1/history?days=90': { body: historyResponse() },
    'GET /v1/specs/gaps': { body: g },
  })

  it('says the store publishes none, and lets an editor mark it as having none to expect', async () => {
    const calls = stubFetch({ ...routes(gaps()), 'PUT /v1/specs/not-expected': { body: { slug: 'widget', reason: '', created_at: '2026-11-15T10:00:00Z' } } })
    renderRoute('/p/us/widget')
    expect(await screen.findByText(/The store publishes no tech specs for this product/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'No specs expected for this' }))
    expect(calls.some((c) => c.key === 'PUT /v1/specs/not-expected' && c.body === JSON.stringify({ slug: 'widget', reason: '' }))).toBe(true)
  })

  it('says so when the store publishes specs but nothing usable came of them (the OCD panels)', async () => {
    stubFetch(routes(gaps({ products: [{ region: 'us', id: 'p1', slug: 'widget', title: 'Widget', category: '', fetched_at: '2026-11-15T10:00:00Z', published: true, not_expected: false }] })))
    renderRoute('/p/us/widget')
    expect(await screen.findByText(/gives the plan checks nothing to use/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'No specs expected for this' })).toBeInTheDocument()
  })

  it('says nothing for a product that has yet to be read from the store', async () => {
    stubFetch(routes(gaps({ products: [{ region: 'us', id: 'p1', slug: 'widget', title: 'Widget', category: '', fetched_at: null, published: false, not_expected: false }] })))
    renderRoute('/p/us/widget')
    await screen.findByRole('heading', { level: 1, name: 'Widget' })
    expect(screen.queryByText(/publishes no tech specs/)).not.toBeInTheDocument()
  })

  it('says none are expected once marked, and lets an editor take the mark off', async () => {
    const calls = stubFetch({
      ...routes(gaps({ not_expected: [{ slug: 'widget', reason: 'just a cover', created_at: '2026-11-15T10:00:00Z' }] })),
      'DELETE /v1/specs/not-expected/widget': { status: 200, body: null },
    })
    renderRoute('/p/us/widget')
    expect(await screen.findByText(/No tech specs are expected for this product \(in any region\): just a cover/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Expect specs again' }))
    expect(calls.some((c) => c.key === 'DELETE /v1/specs/not-expected/widget')).toBe(true)
  })
})
