import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { derived, port, product, productsResponse, variant } from '../test/fixtures'
import { renderRoute, stubFetch } from '../test/render'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }

const catalog = () => {
  const products = [
    product({ id: '1', slug: 'switch-10g', title: 'Switch 10G PoE', type: 'Switches', variants: [variant({ id: 'v1', price_cents: 29900, status: 'Available' })] }),
    product({ id: '2', slug: 'switch-1g', title: 'Switch 1G', type: 'Switches', variants: [variant({ id: 'v2', price_cents: 9900, status: 'SoldOut' })] }),
    product({ id: '3', slug: 'switch-mystery', title: 'Switch Mystery', type: 'Switches', variants: [variant({ id: 'v3', price_cents: 5000, status: 'Available' })] }),
    product({ id: '4', slug: 'ap-6', title: 'Access Point 6E', type: 'WiFi', variants: [variant({ id: 'v4', price_cents: 18900, status: 'Available' })] }),
  ]
  const ds = [
    derived({
      slug: 'switch-10g',
      known,
      ports: [port({ label: '10 GbE RJ45', count: 2, max_speed_mbps: 10000, poe_class: 'PoE+++', poe_direction: 'out' }), port({ count: 24 })],
      metrics: [{ name: 'poe_budget_w', value: 400, unit: 'W', at_least: false, raw: '' }],
    }),
    derived({ slug: 'switch-1g', known, ports: [port({ count: 8 })] }),
    derived({ slug: 'switch-mystery' }), // nothing known
    derived({ slug: 'ap-6', known, ports: [port({ count: 1 })], radios: [{ band: '6 GHz', tech: 'wifi', antenna_gain_dbi: 5, tx_power_dbm: 23, streams: 2, max_rate_mbps: 1 }] }),
  ]
  stubFetch({ 'GET /v1/products': { body: productsResponse({ products }) }, 'GET /v1/derived': { body: ds } })
}

const rowFor = (name: string) => screen.getByRole('link', { name }).closest('tr')!

describe('FindPage', () => {
  it('lists every product with price, stock and the type’s default columns', async () => {
    catalog()
    renderRoute('/find?type=Switches')
    const row = await waitFor(() => rowFor('Switch 10G PoE'))
    expect(within(row).getByText('$299')).toBeInTheDocument()
    expect(within(row).getByText('In stock')).toBeInTheDocument()
    expect(within(row).getByText('10 GbE')).toBeInTheDocument() // fastest port
    expect(within(row).getByText('400 W')).toBeInTheDocument() // PoE budget
    expect(screen.queryByRole('link', { name: 'Access Point 6E' })).not.toBeInTheDocument()
    expect(within(rowFor('Switch 1G')).getByText('Sold out')).toBeInTheDocument()
  })

  it('splits results into matches, can’t-tell and ruled-out, and says why each matched', async () => {
    catalog()
    renderRoute('/find?type=Switches&r=port;speed=10000;poe=PoE%2B%2B%2B')
    const row = await waitFor(() => rowFor('Switch 10G PoE'))
    expect(within(row).getByText(/a 10 GbE\+ port with PoE\+\+\+: 2 × 10 GbE RJ45 \(PoE\+\+\+ out\)/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Matches (1)' })).toBeInTheDocument()
    expect(screen.getByText(/Can't tell \(1\)/)).toBeInTheDocument() // the mystery switch: its ports aren't known
    expect(screen.getByText('1 products ruled out.')).toBeInTheDocument() // the 1G switch
    // The can't-tell product is listed (inside a collapsed section), never silently dropped.
    expect(screen.getByRole('link', { name: 'Switch Mystery' })).toBeInTheDocument()
  })

  it('ignores requirements in the URL that make no sense', async () => {
    catalog()
    renderRoute('/find?type=Switches&r=port;speed=fast&r=nonsense')
    await waitFor(() => rowFor('Switch 1G'))
    expect(screen.getByRole('heading', { name: 'Products (3)' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Current requirements')).not.toBeInTheDocument()
  })

  it('puts a requirement added in the form into the URL and removes it again', async () => {
    catalog()
    const user = userEvent.setup()
    const { router } = renderRoute('/find?type=Switches')
    await waitFor(() => rowFor('Switch 1G'))

    await user.selectOptions(screen.getByLabelText('At least', { selector: 'select' }), '10000')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    const chips = await screen.findByLabelText('Current requirements')
    expect(within(chips).getByText('a 10 GbE+ port')).toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ type: 'Switches', r: ['port;speed=10000'] })

    await user.click(screen.getByRole('button', { name: 'Remove: a 10 GbE+ port' }))
    await waitFor(() => expect(screen.queryByLabelText('Current requirements')).not.toBeInTheDocument())
    expect(router.state.location.search).not.toHaveProperty('r')
  })

  it('asks for a port that powers devices by default when a PoE class is chosen, and ignores direction without one', async () => {
    catalog()
    const user = userEvent.setup()
    const { router } = renderRoute('/find?type=Switches')
    await waitFor(() => rowFor('Switch 1G'))
    await user.selectOptions(screen.getByLabelText('PoE at least'), 'PoE+')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByText('a port with PoE+ out')
    expect(router.state.location.search).toMatchObject({ r: ['port;poe=PoE+;dir=out'] })
  })

  it('refuses a requirement it can’t make sense of, saying why', async () => {
    catalog()
    const user = userEvent.setup()
    const { router } = renderRoute('/find')
    await waitFor(() => rowFor('Switch 1G'))
    await user.selectOptions(screen.getByLabelText('Kind of requirement'), 'metric')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Give a minimum, a maximum, or both.')
    expect(router.state.location.search).not.toHaveProperty('r')
  })

  it('sorts by a column header, unknowns last, and flips on a second click', async () => {
    catalog()
    const user = userEvent.setup()
    renderRoute('/find?type=Switches')
    await waitFor(() => rowFor('Switch 1G'))
    const order = () => screen.getAllByRole('link').map((a) => a.textContent).filter((t) => t?.startsWith('Switch'))

    await user.click(screen.getByRole('button', { name: 'Price' }))
    expect(order()).toEqual(['Switch Mystery', 'Switch 1G', 'Switch 10G PoE'])
    await user.click(screen.getByRole('button', { name: /^Price( ▲| ▼)?$/ }))
    expect(order()).toEqual(['Switch 10G PoE', 'Switch 1G', 'Switch Mystery'])
    expect(screen.getByRole('columnheader', { name: /^Price( ▲| ▼)?$/ })).toHaveAttribute('aria-sort', 'descending')
  })

  it('narrows to in-stock products and by name', async () => {
    catalog()
    const user = userEvent.setup()
    renderRoute('/find?type=Switches&stock=true')
    await waitFor(() => rowFor('Switch 10G PoE'))
    expect(screen.queryByRole('link', { name: 'Switch 1G' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Search by name'), 'mystery')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Switch 10G PoE' })).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Switch Mystery' })).toBeInTheDocument()
  })

  it('picks products to compare, up to four, and links to the comparison', async () => {
    catalog()
    const user = userEvent.setup()
    const { router } = renderRoute('/find?type=Switches')
    await waitFor(() => rowFor('Switch 1G'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Compare Switch 1G'))
    expect(await screen.findByRole('status')).toHaveTextContent('pick one more')
    await user.click(screen.getByLabelText('Compare Switch 10G PoE'))
    const link = await screen.findByRole('link', { name: 'Compare them' })
    expect(router.state.location.search).toMatchObject({ c: ['us/switch-1g', 'us/switch-10g'] })
    expect(link).toHaveAttribute('href', expect.stringContaining('/compare'))

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(router.state.location.search).not.toHaveProperty('c')
  })

  it('lets no more than four be picked at once', async () => {
    const products = ['a', 'b', 'c', 'd', 'e'].map((n, i) => product({ id: n, slug: `sw-${n}`, title: `Switch ${n.toUpperCase()}`, type: 'Switches', variants: [variant({ id: `v${i}` })] }))
    stubFetch({ 'GET /v1/products': { body: productsResponse({ products }) }, 'GET /v1/derived': { body: products.map((p) => derived({ slug: p.slug })) } })
    const user = userEvent.setup()
    renderRoute('/find?type=Switches')
    await waitFor(() => rowFor('Switch A'))
    for (const n of ['A', 'B', 'C', 'D']) await user.click(screen.getByLabelText(`Compare Switch ${n}`))
    expect(screen.getByLabelText('Compare Switch E')).toBeDisabled()
    expect(screen.getByLabelText('Compare Switch A')).toBeEnabled() // the picked ones can still be unpicked
    expect(await screen.findByRole('status')).toHaveTextContent('the most that fit: 4')
  })

  it('offers price-per-unit columns, apart from the others, in the column picker', async () => {
    catalog()
    const user = userEvent.setup()
    renderRoute('/find?type=Switches&cols=per_poe_w')
    const row = await waitFor(() => rowFor('Switch 10G PoE'))
    expect(within(row).getByText('$0.75')).toBeInTheDocument() // $299 over 400 W
    expect(within(rowFor('Switch 1G')).getByText('?')).toBeInTheDocument() // no PoE budget known
    await user.click(screen.getByText('Columns'))
    expect(screen.getByLabelText('Price per PoE watt')).toBeChecked()
  })

  it('says so when the catalogue can’t be loaded', async () => {
    stubFetch({ 'GET /v1/products': { status: 500, body: { error: 'boom' } }, 'GET /v1/derived': { status: 500, body: { error: 'boom' } } })
    renderRoute('/find')
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the catalogue.")
  })
})
