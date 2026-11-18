import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { encodePlan, type PlanLine } from '../lib/plan'
import { setPlan } from '../lib/planStore'
import { derived, port, product, productsResponse, variant } from '../test/fixtures'
import { renderRoute, stubFetch } from '../test/render'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }
const metric = (name: string, value: number) => ({ name, value, unit: 'W', at_least: false, raw: '' })

let products: ReturnType<typeof product>[] = []
const catalog = () => {
  products = [
    product({
      id: '1',
      slug: 'switch',
      title: 'PoE Switch',
      type: 'Switches',
      variants: [variant({ id: 'a', num: 1, sku: 'SW-8', title: '8 port', price_cents: 20000 }), variant({ id: 'b', num: 2, sku: 'SW-16', title: '16 port', price_cents: 35000 })],
    }),
    product({ id: '2', slug: 'ap', title: 'Access Point', type: 'WiFi', variants: [variant({ id: 'c', num: 3, sku: 'AP-1', price_cents: 15000 })] }),
    product({ id: '3', slug: 'gone-stock', title: 'Sold Out Thing', type: 'Switches', variants: [variant({ id: 'd', num: 4, sku: 'SO-1', status: 'SoldOut', price_cents: 5000 })] }),
  ]
  const ds = [
    derived({ slug: 'switch', known, ports: [port({ count: 8, poe_class: 'PoE+', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 100)] }),
    derived({ slug: 'ap', known, ports: [port({ count: 1, poe_class: 'PoE+', poe_direction: 'in' })], metrics: [metric('power_draw_max_w', 20)] }),
    derived({ slug: 'gone-stock', known }),
  ]
  stubFetch({ 'GET /v1/products': { body: productsResponse({ products }) }, 'GET /v1/derived': { body: ds } })
}

const line = (over: Partial<PlanLine>): PlanLine => ({ ref: 'us/switch', sku: 'SW-8', qty: 1, addedCents: 20000, ...over })
const rowFor = (name: string) => screen.getByRole('link', { name }).closest('tr')!

describe('adding to the plan', () => {
  it('adds from the finder, counts it in the nav and remembers it', async () => {
    catalog()
    const user = userEvent.setup()
    renderRoute('/find?type=Switches')
    await user.click(await screen.findByRole('button', { name: 'Add PoE Switch to the plan' }))
    expect(await screen.findByRole('link', { name: 'In plan (1)' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Plan (1)' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/switch:SW-8:1:20000']) // the cheaper variant

    await user.click(screen.getByRole('button', { name: 'Add PoE Switch to the plan' }))
    expect(await screen.findByRole('link', { name: 'In plan (2)' })).toBeInTheDocument()
  })

  it('adds from a product card on the main page', async () => {
    catalog()
    const user = userEvent.setup()
    renderRoute('/')
    await user.click(await screen.findByRole('button', { name: 'Add Access Point to the plan' }))
    expect(await screen.findByRole('link', { name: 'Plan (1)' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/ap:AP-1:1:15000'])
  })

  it('adds from a product page and a comparison', async () => {
    catalog()
    const user = userEvent.setup()
    stubFetch({
      'GET /v1/products': { body: productsResponse({ products: [product({ slug: 'ap', title: 'Access Point', variants: [variant({ sku: 'AP-1' })] })] }) },
      'GET /v1/derived': { body: [derived({ slug: 'ap' })] },
      'GET /v1/products/us/ap/specs': { body: { region: 'us', slug: 'ap', title: 'Access Point', specs: [], overrides: [], derived: null } },
      'GET /v1/history?days=30': { body: { since: '', until: '', variants: [] } },
    })
    renderRoute('/p/us/ap')
    await user.click(await screen.findByRole('button', { name: 'Add Access Point to the plan' }))
    expect(await screen.findByRole('link', { name: 'Plan (1)' })).toBeInTheDocument()
  })
})

describe('PlanPage', () => {
  it('lists lines with live prices, adds up the total and flags what is not in stock', async () => {
    catalog()
    setPlan([line({ qty: 2 }), line({ ref: 'us/ap', sku: 'AP-1', addedCents: 15000 }), line({ ref: 'us/gone-stock', sku: 'SO-1', addedCents: 5000 })])
    renderRoute('/plan')
    const row = await waitFor(() => rowFor('PoE Switch'))
    expect(within(row).getByText('$200')).toBeInTheDocument()
    expect(within(row).getByText('$400')).toBeInTheDocument() // 2 × 200
    const totals = screen.getByLabelText('Totals')
    expect(totals).toHaveTextContent('Total $600') // 400 + 150 + 50
    expect(totals).toHaveTextContent('Not in stock: Sold Out Thing.')
  })

  it('changes a quantity and a variant, and removes a line', async () => {
    catalog()
    const user = userEvent.setup()
    setPlan([line({}), line({ ref: 'us/ap', sku: 'AP-1', addedCents: 15000 })])
    renderRoute('/plan')
    await waitFor(() => rowFor('PoE Switch'))

    const qty = screen.getByLabelText('Quantity of Access Point')
    await user.clear(qty)
    await user.type(qty, '3')
    expect(screen.getByLabelText('Totals')).toHaveTextContent('Total $650') // 200 + 3 × 150
    await user.clear(qty) // an empty box is allowed while typing, and changes nothing
    expect(screen.getByLabelText('Totals')).toHaveTextContent('Total $650')
    await user.type(qty, '0') // so is a number out of range
    expect(screen.getByLabelText('Totals')).toHaveTextContent('Total $650')
    await user.tab()
    expect(qty).toHaveValue(3) // leaving the box shows the real quantity

    await user.selectOptions(screen.getByLabelText('Variant of PoE Switch'), 'SW-16')
    expect(screen.getByLabelText('Totals')).toHaveTextContent('Total $800') // 350 + 450
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toContain('us/switch:SW-16:1:35000')

    await user.click(screen.getByRole('button', { name: 'Remove Access Point from the plan' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Access Point' })).not.toBeInTheDocument())
    expect(screen.getByLabelText('Totals')).toHaveTextContent('Total $350')
  })

  it('shows a price that has changed since the line was added', async () => {
    catalog()
    setPlan([line({ addedCents: 25000 })])
    renderRoute('/plan')
    expect(await screen.findByText('was $250 when added')).toBeInTheDocument()
  })

  it('keeps a line whose product is no longer tracked, uncounted, rather than dropping it', async () => {
    catalog()
    setPlan([line({}), line({ ref: 'us/vanished', sku: 'X' })])
    renderRoute('/plan')
    await screen.findByText('No longer tracked')
    const totals = screen.getByLabelText('Totals')
    expect(totals).toHaveTextContent('Total $200')
    expect(totals).toHaveTextContent('1 line has no price and isn\'t counted.')
    expect(totals).toHaveTextContent('Not in stock: us/vanished.')
  })

  it('works out whether the PoE devices fit, from the derived specs', async () => {
    catalog()
    setPlan([line({}), line({ ref: 'us/ap', sku: 'AP-1', qty: 6, addedCents: 15000 })])
    renderRoute('/plan')
    const checks = await screen.findByLabelText('Checks')
    expect(checks).toHaveTextContent('Devices can draw up to 120 W, over the 100 W the plan supplies.')
    expect(checks).toHaveTextContent('6 PoE+ devices for 8 PoE+ ports.')
  })

  it('says so when the plan is empty', async () => {
    catalog()
    renderRoute('/plan')
    expect(await screen.findByText(/Nothing in the plan yet/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Checks')).not.toBeInTheDocument()
  })

  it('clears the plan only after being asked twice', async () => {
    catalog()
    const user = userEvent.setup()
    setPlan([line({})])
    renderRoute('/plan')
    await user.click(await screen.findByRole('button', { name: 'Clear the plan' }))
    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.getByRole('link', { name: 'PoE Switch' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear the plan' }))
    await user.click(screen.getByRole('button', { name: 'Yes, clear the plan' }))
    expect(await screen.findByText(/Nothing in the plan yet/)).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual([])
  })

  it('offers a link that carries the plan', async () => {
    catalog()
    setPlan([line({ qty: 2 })])
    renderRoute('/plan')
    const box = await screen.findByLabelText('Link to this plan')
    expect(box).toHaveValue(`${window.location.origin}/plan/${encodePlan([line({ qty: 2 })], products)}`)
  })
})

describe('a shared plan', () => {
  const link = (lines: PlanLine[]) => `/plan/${encodePlan(lines, products)}`

  it('is shown read-only, apart from the visitor’s own plan', async () => {
    catalog()
    setPlan([line({ ref: 'us/ap', sku: 'AP-1', addedCents: 15000 })])
    renderRoute(link([line({ qty: 3 })]))
    await screen.findByText(/someone shared with you/)
    await waitFor(() => expect(rowFor('PoE Switch')).toHaveTextContent('$600'))
    expect(screen.queryByRole('link', { name: 'Access Point' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Quantity of/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear the plan' })).not.toBeInTheDocument()
  })

  it('can replace the visitor’s plan, or be left behind', async () => {
    catalog()
    const user = userEvent.setup()
    setPlan([line({ ref: 'us/ap', sku: 'AP-1', addedCents: 15000 })])
    const { router } = renderRoute(link([line({ qty: 3 })]))
    await user.click(await screen.findByRole('button', { name: 'Replace my plan with it' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/plan'))
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/switch:SW-8:3:20000'])
    expect(await screen.findByLabelText('Quantity of PoE Switch')).toHaveValue(3)
  })

  it('offers to keep it when the visitor has no plan, and “back” leaves theirs untouched', async () => {
    catalog()
    const user = userEvent.setup()
    renderRoute(link([line({})]))
    expect(await screen.findByRole('button', { name: 'Keep it as my plan' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to my plan' }))
    expect(await screen.findByText(/Nothing in the plan yet/)).toBeInTheDocument()
    expect(localStorage.getItem('restock-radar.plan')).toBeNull()
  })

  it('says so when the link holds no plan', async () => {
    catalog()
    renderRoute('/plan/!!!')
    expect(await screen.findByText(/doesn't hold a plan/)).toBeInTheDocument()
    expect(screen.queryByText(/someone shared/)).not.toBeInTheDocument()
  })

  it('says how many items it holds that are not tracked here', async () => {
    catalog()
    const stray = encodePlan([line({}), line({ ref: 'us/x', sku: 'X' })], [product({ id: 'x', slug: 'x', variants: [variant({ num: 99, sku: 'X' })] }), ...products])
    renderRoute(`/plan/${stray}`)
    expect(await screen.findByText(/1 item in it isn’t tracked here/)).toBeInTheDocument()
    await waitFor(() => expect(rowFor('PoE Switch')).toBeInTheDocument())
  })
})
