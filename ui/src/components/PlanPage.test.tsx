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
    derived({ slug: 'switch', known, ports: [port({ count: 8, poe_class: 'PoE+', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 100)], power: [{ kind: 'ac', poe_class: '', detail: 'AC' }] }),
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

describe('Find an NVR', () => {
  const nvrCatalog = () => {
    const prods = [
      product({ id: 'c', slug: 'cam', title: 'Dome Camera', type: 'Cameras & Security', category: 'physical-security-dome-turret', variants: [variant({ id: 'c', num: 1, sku: 'CAM-1', price_cents: 15000 })] }),
      product({ id: 'n', slug: 'nvr', title: 'The NVR', type: 'Cameras & Security', category: 'physical-security-nvr', variants: [variant({ id: 'n', num: 2, sku: 'NVR-1', price_cents: 30000 })] }),
    ]
    const ds = [
      derived({ slug: 'cam', known, metrics: [metric('camera_megapixels', 8), metric('power_draw_max_w', 8)], power: [{ kind: 'poe', poe_class: 'PoE', detail: 'PoE' }] }),
      derived({ slug: 'nvr', known, metrics: [metric('nvr_cameras_hd', 60), metric('nvr_cameras_2k', 30), metric('nvr_cameras_4k', 18)] }),
    ]
    stubFetch({ 'GET /v1/products': { body: productsResponse({ products: prods }) }, 'GET /v1/derived': { body: ds } })
  }

  it('notes there is no NVR for the cameras and adds one', async () => {
    nvrCatalog()
    const user = userEvent.setup()
    setPlan([line({ ref: 'us/cam', sku: 'CAM-1', qty: 4, addedCents: 15000 })])
    renderRoute('/plan')
    expect(await screen.findByLabelText('Checks')).toHaveTextContent('4 cameras in the plan, and no NVR (Protect controller) to record them.')
    await user.click(screen.getByRole('button', { name: 'Find an NVR' }))
    const finder = await screen.findByLabelText('Find an NVR')
    expect(finder).toHaveTextContent('Cheapest that fits')
    await user.click(within(finder).getByRole('button', { name: 'Add The NVR to the plan' }))
    await waitFor(() => expect(screen.getByLabelText('Checks')).toHaveTextContent('4 cameras use 22% of the NVR’s capacity.'))
    expect(screen.queryByRole('button', { name: 'Find an NVR' })).not.toBeInTheDocument()
  })
})

describe('Find a gateway or controller', () => {
  it('notes the missing gateway and Network controller, and adds a product that fills both', async () => {
    const prods = [
      product({ id: 'a', slug: 'ap', title: 'Access Point', type: 'WiFi', variants: [variant({ id: 'a', num: 1, sku: 'AP-1', price_cents: 15000 })] }),
      product({ id: 'g', slug: 'gw', title: 'The Gateway', type: 'Gateways', variants: [variant({ id: 'g', num: 2, sku: 'GW-1', price_cents: 30000 })] }),
    ]
    const ds = [
      derived({ slug: 'ap', known, ports: [port({ count: 1 })], power: [{ kind: 'ac', poe_class: '', detail: 'AC' }] }),
      derived({ slug: 'gw', known, ports: [port({ count: 4 })], metrics: [{ name: 'app_network', value: 1, unit: '', at_least: false, raw: '' }] }),
    ]
    stubFetch({ 'GET /v1/products': { body: productsResponse({ products: prods }) }, 'GET /v1/derived': { body: ds } })
    const user = userEvent.setup()
    setPlan([line({ ref: 'us/ap', sku: 'AP-1', qty: 1, addedCents: 15000 })])
    renderRoute('/plan')
    expect(await screen.findByLabelText('Checks')).toHaveTextContent('No gateway in the plan')
    expect(screen.getByLabelText('Checks')).toHaveTextContent('No Network controller in the plan')
    await user.click(screen.getByRole('button', { name: 'Find a gateway or controller' }))
    const finder = await screen.findByLabelText('Find a gateway or controller')
    await user.click(within(finder).getByRole('button', { name: 'Add The Gateway to the plan' }))
    await waitFor(() => expect(screen.getByLabelText('Checks')).toHaveTextContent('The Gateway is the gateway.'))
    expect(screen.getByLabelText('Checks')).toHaveTextContent('The Gateway runs UniFi Network.')
    expect(screen.queryByRole('button', { name: /Find a gateway/ })).not.toBeInTheDocument()
  })
})

describe('Running a controller elsewhere', () => {
  const setup = () => {
    const prods = [
      product({ id: 'a', slug: 'ap', title: 'Access Point', type: 'WiFi', variants: [variant({ id: 'a', num: 1, sku: 'AP-1', price_cents: 15000 })] }),
      product({ id: 'g', slug: 'gw', title: 'The Gateway', type: 'Gateways', variants: [variant({ id: 'g', num: 2, sku: 'GW-1', price_cents: 30000 })] }),
    ]
    const ds = [
      derived({ slug: 'ap', known, ports: [port({ count: 1 })], power: [{ kind: 'ac', poe_class: '', detail: 'AC' }] }),
      derived({ slug: 'gw', known, ports: [port({ count: 4 })], metrics: [{ name: 'ids_ips_throughput_mbps', value: 5000, unit: 'Mbps', at_least: false, raw: '' }, { name: 'app_network', value: 1, unit: '', at_least: false, raw: '' }] }),
    ]
    stubFetch({ 'GET /v1/products': { body: productsResponse({ products: prods }) }, 'GET /v1/derived': { body: ds } })
    setPlan([line({ ref: 'us/ap', sku: 'AP-1', qty: 1, addedCents: 15000 })])
  }

  it('self-hosts the Network controller from the finder, as an entry in the plan, and can remove it', async () => {
    setup()
    const user = userEvent.setup()
    renderRoute('/plan')
    await user.click(await screen.findByRole('button', { name: 'Find a gateway or controller' }))
    const finder = await screen.findByLabelText('Find a gateway or controller')
    // The product's name is in the link, not repeated in the gray line under it.
    expect(within(finder).getAllByText(/The Gateway/)).toHaveLength(1)
    expect(finder).toHaveTextContent('5 Gbps gateway')
    await user.click(within(finder).getByRole('button', { name: 'Self-host UniFi Network' }))
    await waitFor(() => expect(screen.getByLabelText('Checks')).toHaveTextContent('Self-hosted: you run UniFi Network yourself'))
    expect(JSON.parse(localStorage.getItem('restock-radar.plan-hosting')!)).toEqual({ network: 'self' })
    // Only the gateway is still missing, and it can't be run elsewhere.
    expect(within(screen.getByLabelText('Find a gateway or controller')).queryByRole('button', { name: /Self-host/ })).not.toBeInTheDocument()
    // It is an entry in the plan, not just a note in the checks.
    expect(screen.getByLabelText('Plan')).toHaveTextContent('Self-hosted UniFi Network')
    await user.click(screen.getByRole('button', { name: 'Remove self-hosted UniFi Network from the plan' }))
    await waitFor(() => expect(screen.getByLabelText('Checks')).toHaveTextContent('No Network controller in the plan'))
  })
})

describe('Sharing a plan with a self-hosted controller', () => {
  it('shows the entry, counts it in the checks, and has no way to remove it from someone else’s plan', async () => {
    const ap = product({ id: 'a', slug: 'ap', title: 'Access Point', type: 'WiFi', variants: [variant({ id: 'a', num: 1, sku: 'AP-1', price_cents: 15000 })] })
    stubFetch({
      'GET /v1/products': { body: productsResponse({ products: [ap] }) },
      'GET /v1/derived': { body: [derived({ slug: 'ap', known, ports: [port({ count: 1 })] })] },
    })
    const slug = encodePlan([line({ ref: 'us/ap', sku: 'AP-1', qty: 1, addedCents: null })], [ap], { network: 'self' })
    renderRoute(`/plan/${slug}`)
    expect(await screen.findByLabelText('Plan')).toHaveTextContent('Self-hosted UniFi Network')
    expect(screen.getByLabelText('Checks')).toHaveTextContent('Self-hosted: you run UniFi Network yourself')
    expect(screen.queryByRole('button', { name: /Remove self-hosted/ })).not.toBeInTheDocument()
  })
})

describe('Add product on the plan page', () => {
  it('puts the cursor in the search box, so you can type at once', async () => {
    catalog()
    const user = userEvent.setup()
    renderRoute('/plan')
    await user.click(await screen.findByRole('button', { name: 'Add product' }))
    expect(screen.getByRole('combobox', { name: 'Search products to add' })).toHaveFocus()
    await user.keyboard('ap-1')
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  it('searches by name or SKU, and adds the result you click', async () => {
    catalog()
    const user = userEvent.setup()
    renderRoute('/plan')
    await user.click(await screen.findByRole('button', { name: 'Add product' }))
    await user.type(screen.getByRole('combobox', { name: 'Search products to add' }), 'ap-1')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Access Point')
    await user.click(options[0]!)
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/ap:AP-1:1:15000'])
    expect(screen.getByRole('status')).toHaveTextContent('Added Access Point')
  })

  it('moves through the results with the arrow keys and adds the selected one with Enter', async () => {
    catalog()
    const user = userEvent.setup()
    renderRoute('/plan')
    await user.click(await screen.findByRole('button', { name: 'Add product' }))
    const box = screen.getByRole('combobox', { name: 'Search products to add' })
    await user.type(box, 'o') // PoE Switch, Access Point, Sold Out Thing: in stock first
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('PoE Switch'), expect.stringContaining('Access Point'), expect.stringContaining('Sold Out Thing')])
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    expect(box).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]!.id)
    await user.keyboard('{Enter}')
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/ap:AP-1:1:15000'])
    await user.keyboard('{ArrowUp}{ArrowUp}{Enter}') // wraps to the last
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toHaveLength(2)
  })

  it('says when nothing matches', async () => {
    catalog()
    const user = userEvent.setup()
    renderRoute('/plan')
    await user.click(await screen.findByRole('button', { name: 'Add product' }))
    await user.type(screen.getByRole('combobox', { name: 'Search products to add' }), 'zzzz')
    expect(screen.getByRole('status')).toHaveTextContent('Nothing matches')
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

  it('offers the products sold with another (a gateway\'s SSDs) as a choice that adds them to the plan', async () => {
    products = [
      product({ id: '1', slug: 'gw', title: 'Gateway', variants: [variant({ id: 'a', num: 1, sku: 'GW', price_cents: 27900 })], linked: [{ slug: 'ssd-2', label: '2 TB' }, { slug: 'ssd-1', label: '1 TB' }], linked_none: 'No Storage' }),
      product({ id: '2', slug: 'ssd-1', title: 'SSD-1TB', variants: [variant({ id: 'b', num: 2, sku: 'SSD-1', price_cents: 39000 })] }),
      product({ id: '3', slug: 'ssd-2', title: 'SSD-2TB', variants: [variant({ id: 'c', num: 3, sku: 'SSD-2', status: 'SoldOut', price_cents: 73000 })] }),
    ]
    stubFetch({ 'GET /v1/products': { body: productsResponse({ products }) }, 'GET /v1/derived': { body: [] } })
    setPlan([line({ ref: 'us/gw', sku: 'GW', qty: 2, addedCents: 27900 })])
    const user = userEvent.setup()
    renderRoute('/plan')
    const choice = await screen.findByLabelText('Sold with Gateway')
    expect(within(choice).getAllByRole('option').map((o) => o.textContent)).toEqual(['No Storage', '1 TB (+$390)', '2 TB (+$730) — sold out'])
    await user.selectOptions(choice, 'ssd-1')
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/gw:GW:2:27900', 'us/ssd-1:SSD-1:2:39000'])
    await user.selectOptions(choice, 'ssd-2') // replaces the other one
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/gw:GW:2:27900', 'us/ssd-2:SSD-2:2:73000'])
    await user.selectOptions(choice, '')
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/gw:GW:2:27900'])
  })

  it('lets the drives of an NVR with bays be chosen by size and number, one drive line for all the NVRs', async () => {
    products = [
      product({ id: '1', slug: 'unvr', title: 'UNVR', category: 'physical-security-nvr', variants: [variant({ id: 'a', num: 1, sku: 'UNVR', price_cents: 29900 })] }),
      product({ id: '2', slug: 'uacc-hdd-s-4tb', title: '4 TB drive', variants: [variant({ id: 'b', num: 2, sku: 'UACC-HDD-S-4TB', price_cents: 16500 })] }),
      product({ id: '3', slug: 'uacc-hdd-e-16tb', title: '16 TB drive', variants: [variant({ id: 'c', num: 3, sku: 'UACC-HDD-E-16TB', price_cents: 72900 })] }),
      product({ id: '4', slug: 'uacc-hdd-e-8tb', title: '8 TB drive', variants: [variant({ id: 'd', num: 4, sku: 'UACC-HDD-E-8TB', price_cents: 37900 })] }),
    ]
    const ds = [derived({ slug: 'unvr', known, metrics: [metric('nvr_cameras_4k', 18), metric('nvr_drive_bays', 4)] })]
    stubFetch({ 'GET /v1/products': { body: productsResponse({ products }) }, 'GET /v1/derived': { body: ds } })
    setPlan([line({ ref: 'us/unvr', sku: 'UNVR', qty: 2, addedCents: 29900 })])
    const user = userEvent.setup()
    renderRoute('/plan')
    const size = await screen.findByLabelText('Drives for UNVR')
    expect(within(size).getAllByRole('option').map((o) => o.textContent)).toEqual(['No drives', '4 TB drives (+$165 each)', '16 TB drives (+$729 each)']) // not the 8 TB
    await user.selectOptions(size, 'uacc-hdd-e-16tb') // a full set in each of the two NVRs
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/unvr:UNVR:2:29900', 'us/uacc-hdd-e-16tb:UACC-HDD-E-16TB:8:72900'])
    await user.selectOptions(screen.getByLabelText('Number of drives for UNVR'), '3')
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/unvr:UNVR:2:29900', 'us/uacc-hdd-e-16tb:UACC-HDD-E-16TB:6:72900'])
    await user.selectOptions(size, '')
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/unvr:UNVR:2:29900'])
  })

  it('lets the way a switch is powered be chosen, and puts the adapter it runs on in the plan', async () => {
    products = [
      product({ id: '1', slug: 'flex', title: 'Flex PoE', type: 'Switches', variants: [variant({ id: 'a', num: 1, sku: 'FLEX', price_cents: 19900 })] }),
      product({ id: '2', slug: 'uacc-adapter-ac-210w', title: 'AC Adapter 210W', type: 'Accessories', variants: [variant({ id: 'b', num: 2, sku: 'ADAPTER', price_cents: 7900 })] }),
    ]
    const ds = [derived({ slug: 'flex', known, ports: [port({ count: 8, poe_class: 'PoE++', poe_direction: 'out' })], poe_budget: [{ name: 'PoE+ input', watts: 16, selected: false }, { name: '210W AC adapter input', watts: 196, selected: true }], power: [{ kind: 'ac', poe_class: '', detail: '(1) AC/DC adapter (Excluded)' }] })]
    stubFetch({ 'GET /v1/products': { body: productsResponse({ products }) }, 'GET /v1/derived': { body: ds } })
    setPlan([line({ ref: 'us/flex', sku: 'FLEX', qty: 2, addedCents: 19900 })])
    const user = userEvent.setup()
    renderRoute('/plan')
    const choice = await screen.findByLabelText('Power for Flex PoE')
    expect(choice).toHaveValue('') // not chosen yet
    await user.selectOptions(choice, screen.getByRole('option', { name: /210W AC adapter: 196 W/ }))
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/flex:FLEX:2:19900', 'us/uacc-adapter-ac-210w:ADAPTER:2:7900'])
    expect(JSON.parse(localStorage.getItem('restock-radar.plan-power')!)).toEqual({ 'us/flex:FLEX': expect.any(Number) })
  })

  it('makes a switch with a 60 W or 210 W adapter in the box a matter of which product it is, in place', async () => {
    const budget = [{ name: 'PoE+ input', watts: 16, selected: false }, { name: '60W AC adapter input', watts: 52, selected: false }, { name: '210W AC adapter input', watts: 202, selected: true }]
    products = [
      product({ id: '1', slug: 'usw-ultra', title: 'Switch Ultra', type: 'Switches', collection: 'pro-ultra', variants: [variant({ id: 'a', num: 1, sku: 'U', price_cents: 12900 })] }),
      product({ id: '2', slug: 'usw-ultra-60w', title: 'Switch Ultra 60W', type: 'Switches', collection: 'pro-ultra', variants: [variant({ id: 'b', num: 2, sku: 'U60', price_cents: 15900 })] }),
      product({ id: '3', slug: 'ap', title: 'Access Point', type: 'WiFi', variants: [variant({ id: 'c', num: 3, sku: 'AP', price_cents: 15000 })] }),
    ]
    const ports = [port({ count: 8, poe_class: 'PoE+', poe_direction: 'out' })]
    const ds = [
      derived({ slug: 'usw-ultra', known, ports, poe_budget: budget, power: [{ kind: 'ac', poe_class: '', detail: '(1) AC/DC adapter (Excluded)' }] }),
      derived({ slug: 'usw-ultra-60w', known, ports, poe_budget: budget.map((s) => ({ ...s, selected: s.name.startsWith('60W') })), power: [{ kind: 'ac', poe_class: '', detail: '(1) AC/DC adapter (Included)' }] }),
    ]
    stubFetch({ 'GET /v1/products': { body: productsResponse({ products }) }, 'GET /v1/derived': { body: ds } })
    setPlan([line({ ref: 'us/usw-ultra', sku: 'U', qty: 2, addedCents: 12900 }), line({ ref: 'us/ap', sku: 'AP', qty: 1, addedCents: 15000 })])
    const user = userEvent.setup()
    renderRoute('/plan')
    const choice = await screen.findByLabelText('Power for Switch Ultra')
    expect(within(choice).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose how it is powered', 'PoE+: 16 W', '60W AC adapter: 52 W (as Switch Ultra 60W)', '210W AC adapter: 202 W (adapter added)']) // no 210 W product here, so that one is an adapter to buy
    await user.selectOptions(choice, screen.getByRole('option', { name: /60W AC adapter/ }))
    // The line becomes the product that comes with it, where it was and as many; no adapter is added.
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toEqual(['us/usw-ultra-60w:U60:2:15900', 'us/ap:AP:1:15000'])
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

  it('offers to find a switch when the plan lacks power or ports, and adds the one chosen', async () => {
    catalog()
    const user = userEvent.setup()
    // Six access points draw 120 W; the one switch in the plan supplies 100 W.
    setPlan([line({}), line({ ref: 'us/ap', sku: 'AP-1', qty: 6, addedCents: 15000 })])
    renderRoute('/plan')
    await user.click(await screen.findByRole('button', { name: 'Find a switch' }))
    const finder = await screen.findByLabelText('Find a switch')
    expect(finder).toHaveTextContent('Cheapest that fits')
    await user.click(within(finder).getByRole('button', { name: /^Add .*PoE Switch to the plan$/ }))
    await waitFor(() => expect(screen.getByLabelText('Checks')).toHaveTextContent('of the 200 W supplied'))
    expect(screen.queryByRole('button', { name: 'Find a switch' })).not.toBeInTheDocument()
  })

  it('shows how each suggested switch is powered, with AC and PoE accepted and DC not by default', async () => {
    catalog()
    const user = userEvent.setup()
    setPlan([line({}), line({ ref: 'us/ap', sku: 'AP-1', qty: 6, addedCents: 15000 })])
    renderRoute('/plan')
    await user.click(await screen.findByRole('button', { name: 'Find a switch' }))
    const finder = await screen.findByLabelText('Find a switch')
    expect(within(finder).getByRole('checkbox', { name: 'AC' })).toBeChecked()
    expect(within(finder).getByRole('checkbox', { name: 'PoE' })).toBeChecked()
    expect(within(finder).getByRole('checkbox', { name: 'DC' })).not.toBeChecked()
    expect(finder).toHaveTextContent('Powered by AC')
    await user.click(within(finder).getByRole('checkbox', { name: 'AC' }))
    expect(finder).toHaveTextContent('No switch we track')
    expect(finder).toHaveTextContent('would work on others')
  })

  it('does not offer a switch when the plan already has the power and ports', async () => {
    catalog()
    setPlan([line({}), line({ ref: 'us/ap', sku: 'AP-1', qty: 2, addedCents: 15000 })])
    renderRoute('/plan')
    await screen.findByLabelText('Checks')
    expect(screen.queryByRole('button', { name: 'Find a switch' })).not.toBeInTheDocument()
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
    expect(screen.queryByLabelText('Link to this plan')).not.toBeInTheDocument() // behind the share button
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Share this plan' }))
    const box = await screen.findByLabelText('Link to this plan')
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    expect(box).toHaveValue(`${window.location.origin}/plan/${encodePlan([line({ qty: 2 })], products)}`)
  })
})

describe('the topology', () => {
  it('draws the gateway, what hangs from it and the devices on it, below the plan and shut when narrow', async () => {
    products = [
      product({ id: '1', slug: 'gw', title: 'Gateway', type: 'Gateways', variants: [variant({ id: 'a', num: 1, sku: 'GW', price_cents: 20000 })] }),
      product({ id: '2', slug: 'switch', title: 'PoE Switch', type: 'Switches', variants: [variant({ id: 'b', num: 2, sku: 'SW-8', price_cents: 20000 })] }),
      product({ id: '3', slug: 'ap', title: 'Access Point', type: 'WiFi', variants: [variant({ id: 'c', num: 3, sku: 'AP-1', price_cents: 15000 })] }),
    ]
    const ds = [
      derived({ slug: 'gw', known, ports: [port({ count: 2, max_speed_mbps: 1000 })] }),
      derived({ slug: 'switch', known, ports: [port({ count: 8, poe_class: 'PoE+', poe_direction: 'out' })], metrics: [metric('poe_budget_w', 100)] }),
      derived({ slug: 'ap', known, ports: [port({ count: 1, poe_class: 'PoE+', poe_direction: 'in' })], metrics: [metric('power_draw_max_w', 20)] }),
    ]
    stubFetch({ 'GET /v1/products': { body: productsResponse({ products }) }, 'GET /v1/derived': { body: ds } })
    setPlan([line({ ref: 'us/gw', sku: 'GW' }), line({}), line({ ref: 'us/ap', sku: 'AP-1', qty: 3 })])
    renderRoute('/plan')
    const tree = await screen.findByRole('list', { name: 'Device topology' })
    const top = within(tree).getAllByRole('listitem')
    expect(top[0]).toHaveTextContent('Gateway')
    expect(within(tree).getByText(/Access Point/)).toHaveTextContent('Access Point × 3')
    const section = screen.getByLabelText('Topology')
    expect(section.querySelector('details')).not.toHaveAttribute('open') // no wide screen in a test
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('125%')
    await user.click(screen.getByRole('button', { name: 'Zoom out' }))
    await user.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('75%')
    await user.click(screen.getByRole('button', { name: 'Reset zoom' }))
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeDisabled()
    const labels = [...document.querySelectorAll('[aria-label="Plan"],[aria-label="Topology"],[aria-label="Checks"]')].map((e) => e.getAttribute('aria-label'))
    expect(labels).toEqual(['Plan', 'Topology', 'Checks'])
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

describe('Converting to another region', () => {
  it('opens the plan as a new plan in the other region, and says what could not come along', async () => {
    const eu = (over: Parameters<typeof product>[0]) => product({ region: 'eu', ...over })
    const all = [
      product({ id: '1', slug: 'switch', title: 'PoE Switch', variants: [variant({ id: 'a', num: 1, sku: 'SW-8', price_cents: 20000 })] }),
      product({ id: '2', slug: 'ap', title: 'Access Point', variants: [variant({ id: 'c', num: 3, sku: 'AP-1', price_cents: 15000 })] }),
      eu({ id: '1', slug: 'switch', title: 'PoE Switch', variants: [variant({ id: 'e', num: 11, sku: 'SW-8-EU', currency: 'EUR', price_cents: 18000 })] }),
    ]
    stubFetch({ 'GET /v1/products': { body: productsResponse({ regions: ['us', 'eu'], products: all }) }, 'GET /v1/derived': { body: [] } })
    setPlan([line({ qty: 2 }), line({ ref: 'us/ap', sku: 'AP-1', qty: 1, addedCents: 15000 })])
    const user = userEvent.setup()
    renderRoute('/plan')

    await user.click(await screen.findByRole('button', { name: 'Convert to another region' }))
    const dialog = screen.getByRole('dialog', { name: 'Convert this plan' })
    expect(within(dialog).getByRole('combobox')).toHaveValue('eu') // not the region it is in
    expect(within(dialog).getByText(/1 of 2 lines carry over to Europe/)).toBeInTheDocument()
    expect(within(dialog).getByText(/SW-8 is SW-8-EU/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Access Point is not sold there/)).toBeInTheDocument()

    const link = within(dialog).getByRole('link', { name: /Open the converted plan in a new tab/ })
    expect(link).toHaveAttribute('target', '_blank')
    const slug = link.getAttribute('href')!.replace('/plan/', '')
    expect(slug).toBe(encodePlan([{ ref: 'eu/switch', sku: 'SW-8-EU', qty: 2, addedCents: null }], all))
    // Hers is untouched.
    expect(JSON.parse(localStorage.getItem('restock-radar.plan')!)).toHaveLength(2)
  })
})
