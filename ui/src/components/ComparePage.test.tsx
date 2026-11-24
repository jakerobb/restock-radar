import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { derived, port, product, productsResponse, variant } from '../test/fixtures'
import { renderRoute, stubFetch } from '../test/render'
import { resetRegionChoice } from '../hooks/useRegion'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
const metric = (name: string, value: number) => ({ name, value, unit: 'W', at_least: false, raw: '' })

const catalog = () => {
  const products = [
    product({ id: '1', slug: 'sw-a', title: 'Switch A', type: 'Switches', variants: [variant({ id: 'v1', price_cents: 30000 })] }),
    product({ id: '2', slug: 'sw-b', title: 'Switch B', type: 'Switches', variants: [variant({ id: 'v2', price_cents: 50000 })] }),
    product({ id: '3', slug: 'sw-c', title: 'Switch C', type: 'Switches', variants: [variant({ id: 'v3', price_cents: 20000 })] }),
    product({ id: '4', slug: 'ap', title: 'Access Point', type: 'WiFi', variants: [variant({ id: 'v4', price_cents: 18000 })] }),
  ]
  const ds = [
    derived({ slug: 'sw-a', known, ports: [port({ count: 24 })], metrics: [metric('poe_budget_w', 200), metric('power_draw_max_w', 40)] }),
    derived({ slug: 'sw-b', known, ports: [port({ count: 24 })], metrics: [metric('poe_budget_w', 400), metric('power_draw_max_w', 40)] }),
    derived({ slug: 'sw-c', known, ports: [port({ count: 8 })] }),
    derived({ slug: 'ap', known }),
  ]
  stubFetch({ 'GET /v1/products': { body: productsResponse({ products }) }, 'GET /v1/derived': { body: ds } })
}

describe('ComparePage', () => {
  it('lines the products up and marks the best price', async () => {
    catalog()
    renderRoute('/compare?p=us/sw-a&p=us/sw-b')
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('link', { name: 'Switch A' })).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'Switch B' })).toBeInTheDocument()
    const price = within(table).getByRole('rowheader', { name: 'Price' }).closest('tr')!
    expect(within(price).getByText('$300')).toBeInTheDocument()
    expect(within(price).getByText('(best)', { exact: false }).parentElement).toHaveTextContent('$300')
    expect(within(table).getByRole('rowheader', { name: 'PoE budget' })).toBeInTheDocument()
  })

  it('hides the rows where the products agree when asked to show only the differences', async () => {
    catalog()
    const user = userEvent.setup()
    const { router } = renderRoute('/compare?p=us/sw-a&p=us/sw-b')
    await screen.findByRole('rowheader', { name: 'Max power draw' }) // both 40 W
    await user.click(screen.getByLabelText('Show only the differences'))
    await waitFor(() => expect(screen.queryByRole('rowheader', { name: 'Max power draw' })).not.toBeInTheDocument())
    expect(screen.getByRole('rowheader', { name: 'PoE budget' })).toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ diff: true })
  })

  it('adds a product by name, the first one’s type first, and removes one', async () => {
    catalog()
    const user = userEvent.setup()
    const { router } = renderRoute('/compare?p=us/sw-a')
    await screen.findByRole('link', { name: 'Switch A' })
    expect(screen.getByText(/Choose one more product/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('Add a product'), 'a')
    const suggestions = await screen.findByRole('list', { name: 'Suggestions' })
    const names = within(suggestions).getAllByRole('button').map((b) => b.textContent)
    expect(names[0]).toMatch(/^Switch/) // Switches before the access point
    expect(names.some((n) => n?.startsWith('Switch A'))).toBe(false) // already chosen
    await user.click(within(suggestions).getByRole('button', { name: /Switch B/ }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ p: ['us/sw-a', 'us/sw-b'] }))

    await user.click(screen.getByRole('button', { name: 'Remove Switch A' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ p: ['us/sw-b'] }))
  })

  it('stops at four products', async () => {
    catalog()
    renderRoute('/compare?p=us/sw-a&p=us/sw-b&p=us/sw-c&p=us/ap&p=us/extra')
    await screen.findByRole('table')
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(4)
    expect(screen.getByLabelText('Add a product')).toBeDisabled()
  })

  it('says which products aren’t tracked and offers to drop them', async () => {
    catalog()
    const user = userEvent.setup()
    const { router } = renderRoute('/compare?p=us/sw-a&p=us/gone')
    expect(await screen.findByRole('alert')).toHaveTextContent('Not tracking us/gone')
    await user.click(screen.getByRole('button', { name: 'Drop it' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ p: ['us/sw-a'] }))
  })

  it('ignores a malformed list in the URL', async () => {
    catalog()
    renderRoute('/compare?p=nonsense&diff=maybe')
    expect(await screen.findByText(/Choose at least two products/)).toBeInTheDocument()
  })
})

describe('ComparePage in another region', () => {
  afterEach(() => {
    window.localStorage.clear()
    resetRegionChoice()
  })

  const serve = () => {
    const eu = (o: Parameters<typeof product>[0]) => product({ region: 'eu', ...o })
    const products = [
      product({ id: '1', slug: 'sw-a', title: 'Switch A', variants: [variant({ id: 'v1', price_cents: 30000 })] }),
      product({ id: '2', slug: 'sw-b', title: 'Switch B', variants: [variant({ id: 'v2', price_cents: 50000 })] }),
      eu({ id: '1', slug: 'sw-a', title: 'Switch A', variants: [variant({ id: 'e1', currency: 'EUR', price_cents: 28000 })] }),
    ]
    stubFetch({ 'GET /v1/products': { body: productsResponse({ regions: ['us', 'eu'], products }) }, 'GET /v1/derived': { body: [derived({ slug: 'sw-a', known }), derived({ slug: 'sw-b', known })] } })
  }

  it('shows each product\'s equivalent in the picked region, and a placeholder for one that has none', async () => {
    serve()
    window.localStorage.setItem('restock-radar.region', 'eu')
    const { router } = renderRoute('/compare?p=us/sw-a&p=us/sw-b')
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('link', { name: 'Switch A' })).toHaveAttribute('href', '/p/eu/sw-a')
    expect(within(table).getByText('Not available in Europe.')).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'United States' })).toHaveAttribute('href', '/p/us/sw-b')
    // The URL still holds what was chosen, so the slot comes back wherever it is sold.
    expect(router.state.location.search).toMatchObject({ p: ['us/sw-a', 'us/sw-b'] })
  })

  it('brings a slot back when the region it is sold in is picked again', async () => {
    serve()
    window.localStorage.setItem('restock-radar.region', 'eu')
    renderRoute('/compare?p=us/sw-a&p=us/sw-b')
    await screen.findByText('Not available in Europe.')
    await userEvent.click(screen.getByRole('combobox', { name: 'Store region' }))
    await userEvent.click(screen.getByRole('option', { name: /United States/ }))
    await waitFor(() => expect(screen.queryByText('Not available in Europe.')).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Switch B' })).toHaveAttribute('href', '/p/us/sw-b')
  })

  it('removes a placeholder slot from the URL', async () => {
    serve()
    window.localStorage.setItem('restock-radar.region', 'eu')
    const { router } = renderRoute('/compare?p=us/sw-a&p=us/sw-b')
    await screen.findByText('Not available in Europe.')
    await userEvent.click(screen.getByRole('button', { name: 'Remove Switch B' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ p: ['us/sw-a'] }))
  })
})
