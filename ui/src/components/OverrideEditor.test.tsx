import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Me, OverrideChange, ProductSpecsResponse, SpecEntry, SpecOverride } from '../api/types'
import { derived, historyResponse, product, productsResponse } from '../test/fixtures'
import { anonymousMe, renderRoute, signedInMe, stubFetch } from '../test/render'

const entry = (o: Partial<SpecEntry>): SpecEntry => ({ section_id: 'perf', section: 'Performance', section_type: 'Standard', feature_id: 'f', label: 'Thing', kind: 'text', value: 'x', origin: 'published', ...o })

const override = (o: Partial<SpecOverride> = {}): SpecOverride => ({
  id: 7, region: 'us', slug: 'widget', action: 'set', section: 'Performance', group: '', label: 'IDS/IPS Throughput', kind: 'text', value: '8+ Gbps', note: '',
  source_url: 'https://example.com/teardown', reason: 'Measured in a teardown', status: 'overrides', stale: false, published_now: '5 Gbps', published_value: '5 Gbps',
  created_by: 'kim', updated_by: 'lee', created_at: new Date(Date.now() - 86_400_000).toISOString(), updated_at: new Date().toISOString(), ...o,
})

const specs = (o: Partial<ProductSpecsResponse> = {}): ProductSpecsResponse => ({
  region: 'us', id: 'p1', slug: 'widget', title: 'Widget', category: '',
  specs: [
    entry({ label: 'IDS/IPS Throughput', value: '8+ Gbps', origin: 'override', published_value: '5 Gbps', override_id: 7, feature_id: 'ids' }),
    entry({ label: 'Switching Capacity', value: '112 Gbps', feature_id: 'sw' }),
    entry({ label: 'Max. TX Power', kind: 'group', value: undefined, feature_id: 'g-tx' }),
    entry({ label: '6 GHz', value: '23 dBm', parent_id: 'g-tx', feature_id: 'tx6' }),
    entry({ label: 'Hardware Offload', kind: 'flag', value: 'true', feature_id: 'off' }),
    entry({ label: 'Teardown finding', value: 'Has a spare header', origin: 'added', override_id: 9, feature_id: 'added' }),
  ],
  overrides: [override()],
  derived: derived(),
  ...o,
})

const change = (o: Partial<OverrideChange>): OverrideChange => ({
  id: 1, at: new Date().toISOString(), actor: 'kim', change: 'create', override_id: 7, region: 'us', slug: 'widget', before: null, after: override(), ...o,
})

const routes = (me: Me, extra: Record<string, { status?: number; body: unknown }> = {}) => ({
  'GET /v1/me': { body: me },
  'GET /v1/products': { body: productsResponse({ products: [product({ slug: 'widget', title: 'Widget' })] }) },
  'GET /v1/products/us/widget/specs': { body: specs() },
  'GET /v1/history?days=90': { body: historyResponse() },
  'GET /v1/overrides/history?region=us&slug=widget': { body: [change({ id: 2, actor: 'lee', change: 'update', before: override({ value: '8 Gbps' }) }), change({ id: 1 })] },
  ...extra,
})

const editor = signedInMe('kim', ['overrides:write', 'products:refresh'])

describe('a visitor who may not change anything', () => {
  it('sees the specification and the corrections, but no way to change them', async () => {
    stubFetch(routes(anonymousMe()))
    renderRoute('/p/us/widget')

    const hardware = await screen.findByRole('region', { name: 'Performance' })
    expect(hardware).toHaveTextContent('8+ Gbps')
    expect(screen.getByRole('region', { name: 'Overrides' })).toHaveTextContent('Measured in a teardown')
    expect(screen.queryByRole('button', { name: /^Correct/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Add a fact' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Correction history' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove the correction/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refresh from store' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument()
  })

  it('sees no one’s name', async () => {
    stubFetch(routes(anonymousMe(), { 'GET /v1/products/us/widget/specs': { body: specs({ overrides: [override({ created_by: undefined, updated_by: undefined })] }) } }))
    renderRoute('/p/us/widget')
    await screen.findByRole('region', { name: 'Overrides' })
    expect(screen.queryByText(/By lee|Made by/)).not.toBeInTheDocument()
  })

  it('is not offered a refresh if it lacks that permission, even when it may edit', async () => {
    stubFetch(routes(signedInMe('kim', ['overrides:write'])))
    renderRoute('/p/us/widget')
    await screen.findByRole('region', { name: 'Add a fact' })
    expect(screen.queryByRole('button', { name: 'Refresh from store' })).not.toBeInTheDocument()
  })
})

describe('an editor', () => {
  it('is told who they are, and sees who made each correction and the history', async () => {
    stubFetch(routes(editor))
    renderRoute('/p/us/widget')

    expect(await screen.findByText(/Signed in as/)).toHaveTextContent('Signed in as kim')
    expect(await screen.findByText('Made by kim, last changed by lee, just now')).toBeInTheDocument()
    const history = await screen.findByRole('region', { name: 'Correction history' })
    await waitFor(() => expect(history).toHaveTextContent('changed “IDS/IPS Throughput”: 8 Gbps → 8+ Gbps'))
    expect(history).toHaveTextContent('lee')
    expect(history).toHaveTextContent('added set “IDS/IPS Throughput” to 8+ Gbps')
    expect(screen.getByRole('button', { name: 'Refresh from store' })).toBeInTheDocument()
  })

  it('corrects an entry, and the form says what the store publishes', async () => {
    const calls = stubFetch(routes(editor, { 'PUT /v1/overrides': { body: override() } }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    await user.click(await screen.findByRole('button', { name: 'Correct Switching Capacity' }))
    const form = screen.getByRole('form', { name: 'Correct Switching Capacity' })
    expect(form).toHaveTextContent('The store publishes: 112 Gbps')

    await user.clear(within(form).getByLabelText('Value'))
    await user.type(within(form).getByLabelText('Value'), '120 Gbps')
    await user.type(within(form).getByLabelText('Source URL'), 'https://example.com/t')
    await user.type(within(form).getByLabelText('Reason'), 'measured')
    await user.click(within(form).getByRole('button', { name: 'Save correction' }))

    await waitFor(() => expect(screen.queryByRole('form', { name: 'Correct Switching Capacity' })).not.toBeInTheDocument())
    const put = calls.find((c) => c.key === 'PUT /v1/overrides')!
    expect(JSON.parse(put.body!)).toEqual({
      region: 'us', slug: 'widget', action: 'set', section: 'Performance', label: 'Switching Capacity', kind: 'text', value: '120 Gbps', source_url: 'https://example.com/t', reason: 'measured',
    })
    // What was shown is read again, now that it has changed.
    await waitFor(() => expect(calls.filter((c) => c.key === 'GET /v1/products/us/widget/specs').length).toBeGreaterThan(1))
  })

  it('names the group an entry sits under', async () => {
    const calls = stubFetch(routes(editor, { 'PUT /v1/overrides': { body: override() } }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    await user.click(await screen.findByRole('button', { name: 'Correct 6 GHz' }))
    const form = screen.getByRole('form', { name: 'Correct 6 GHz' })
    await user.clear(within(form).getByLabelText('Value'))
    await user.type(within(form).getByLabelText('Value'), '30 dBm')
    await user.click(within(form).getByRole('button', { name: 'Save correction' }))
    await waitFor(() => expect(calls.some((c) => c.key === 'PUT /v1/overrides')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.key === 'PUT /v1/overrides')!.body!)).toMatchObject({ section: 'Performance', group: 'Max. TX Power', label: '6 GHz', value: '30 dBm' })
  })

  it('edits a yes/no entry with a yes/no choice, not free text', async () => {
    const calls = stubFetch(routes(editor, { 'PUT /v1/overrides': { body: override() } }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    await user.click(await screen.findByRole('button', { name: 'Correct Hardware Offload' }))
    const form = screen.getByRole('form', { name: 'Correct Hardware Offload' })
    await user.selectOptions(within(form).getByLabelText('Value'), 'false')
    await user.click(within(form).getByRole('button', { name: 'Save correction' }))
    await waitFor(() => expect(calls.some((c) => c.key === 'PUT /v1/overrides')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.key === 'PUT /v1/overrides')!.body!)).toMatchObject({ kind: 'flag', value: 'false', label: 'Hardware Offload' })
  })

  it('hides an entry', async () => {
    const calls = stubFetch(routes(editor, { 'PUT /v1/overrides': { body: override({ action: 'hide' }) } }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    await user.click(await screen.findByRole('button', { name: 'Correct Switching Capacity' }))
    await user.click(screen.getByRole('button', { name: 'Hide this entry' }))
    await waitFor(() => expect(calls.some((c) => c.key === 'PUT /v1/overrides')).toBe(true))
    const body = JSON.parse(calls.find((c) => c.key === 'PUT /v1/overrides')!.body!)
    expect(body).toMatchObject({ action: 'hide', section: 'Performance', label: 'Switching Capacity' })
    expect(body).not.toHaveProperty('value')
  })

  it('starts from the override when correcting an overridden entry, and can revert it', async () => {
    const calls = stubFetch(routes(editor, { 'DELETE /v1/overrides/7': { body: null } }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    await user.click(await screen.findByRole('button', { name: 'Correct IDS/IPS Throughput' }))
    const form = screen.getByRole('form', { name: 'Correct IDS/IPS Throughput' })
    expect(within(form).getByLabelText('Value')).toHaveValue('8+ Gbps')
    expect(within(form).getByLabelText('Reason')).toHaveValue('Measured in a teardown')
    expect(form).toHaveTextContent('The store publishes: 5 Gbps')

    await user.click(within(form).getByRole('button', { name: 'Revert to published' }))
    await waitFor(() => expect(calls.some((c) => c.key === 'DELETE /v1/overrides/7')).toBe(true))
  })

  it('can remove an added entry, but not hide it', async () => {
    const calls = stubFetch(routes(editor, { 'DELETE /v1/overrides/9': { body: null } }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    await user.click(await screen.findByRole('button', { name: 'Correct Teardown finding' }))
    expect(screen.queryByRole('button', { name: 'Hide this entry' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove this entry' }))
    await waitFor(() => expect(calls.some((c) => c.key === 'DELETE /v1/overrides/9')).toBe(true))
  })

  it('shows the server’s reason when a correction is refused, and keeps the form', async () => {
    stubFetch(routes(editor, { 'PUT /v1/overrides': { status: 400, body: { error: 'a value is required (to remove an entry, hide it)' } } }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    await user.click(await screen.findByRole('button', { name: 'Correct Switching Capacity' }))
    const form = screen.getByRole('form', { name: 'Correct Switching Capacity' })
    await user.click(within(form).getByRole('button', { name: 'Save correction' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('a value is required')
    expect(screen.getByRole('form', { name: 'Correct Switching Capacity' })).toBeInTheDocument()
  })

  it('closes the form on Cancel without saving', async () => {
    const calls = stubFetch(routes(editor))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')
    await user.click(await screen.findByRole('button', { name: 'Correct Switching Capacity' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Correct Switching Capacity' })).not.toBeInTheDocument()
    expect(calls.some((c) => c.key.startsWith('PUT'))).toBe(false)
  })

  it('removes a correction from the list', async () => {
    const calls = stubFetch(routes(editor, { 'DELETE /v1/overrides/7': { body: null } }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')
    await user.click(await screen.findByRole('button', { name: 'Remove the correction to IDS/IPS Throughput' }))
    await waitFor(() => expect(calls.some((c) => c.key === 'DELETE /v1/overrides/7')).toBe(true))
  })

  it('adds a fact the store does not publish, offering the sections that exist', async () => {
    const calls = stubFetch(routes(editor, { 'PUT /v1/overrides': { body: override({ label: 'Max. Bitrate', value: '8 Mbps' }) } }))
    const user = userEvent.setup()
    renderRoute('/p/us/widget')

    const card = await screen.findByRole('region', { name: 'Add a fact' })
    expect(card.querySelector('datalist')).toHaveTextContent('') // options are values, not text
    expect([...card.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['Performance'])

    await user.type(within(card).getByLabelText('Section'), 'Hardware')
    await user.type(within(card).getByLabelText('Label'), 'Max. Bitrate')
    await user.type(within(card).getByLabelText('Value'), '8 Mbps')
    await user.type(within(card).getByLabelText('Reason'), 'teardown')
    await user.click(within(card).getByRole('button', { name: 'Add fact' }))

    expect(await within(card).findByRole('status')).toHaveTextContent('Added.')
    expect(JSON.parse(calls.find((c) => c.key === 'PUT /v1/overrides')!.body!)).toEqual({
      region: 'us', slug: 'widget', action: 'set', section: 'Hardware', label: 'Max. Bitrate', kind: 'text', value: '8 Mbps', reason: 'teardown',
    })
    expect(within(card).getByLabelText('Label')).toHaveValue('') // ready for the next one
  })
})

describe('the watch list', () => {
  it('offers Add product only to those who may add products', async () => {
    stubFetch({ 'GET /v1/me': { body: signedInMe('kim', ['overrides:write']) }, 'GET /v1/products': { body: productsResponse() }, 'GET /v1/history?days=90': { body: historyResponse() } })
    renderRoute('/')
    await screen.findByText(/Last synced/)
    expect(screen.queryByRole('button', { name: 'Add product' })).not.toBeInTheDocument()
  })

  it('offers it to those who may', async () => {
    stubFetch({ 'GET /v1/me': { body: signedInMe('kim', ['watchlist:write']) }, 'GET /v1/products': { body: productsResponse() }, 'GET /v1/history?days=90': { body: historyResponse() } })
    renderRoute('/')
    expect(await screen.findByRole('button', { name: 'Add product' })).toBeInTheDocument()
  })
})
