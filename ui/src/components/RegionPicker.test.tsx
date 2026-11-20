import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { historyResponse, product, productsResponse, variant } from '../test/fixtures'
import { renderWithClient, stubFetch } from '../test/render'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function serve(languages: string[] = ['en-US']) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
  stubFetch({
    'GET /v1/history?days=90': { body: historyResponse() },
    'GET /v1/products': {
      body: productsResponse({
        regions: ['us', 'eu', 'jp'],
        products: [
          product({ id: 'u1', region: 'us', slug: 'camera', title: 'Camera US', variants: [variant({ id: 'a' })] }),
          product({ id: 'e1', region: 'eu', slug: 'camera', title: 'Camera EU', variants: [variant({ id: 'b', currency: 'EUR' })] }),
          product({ id: 'j1', region: 'jp', slug: 'camera', title: 'Camera JP', variants: [variant({ id: 'c', currency: 'JPY', price_cents: 33727 })] }),
        ],
        pending: [{ region: 'eu', slug: 'waiting-eu' }],
      }),
    },
  })
}

describe('RegionPicker', () => {
  it('shows the products of one region, chosen by the browser language to begin with', async () => {
    serve(['de-DE'])
    renderWithClient(<App />)
    expect(await screen.findByRole('heading', { name: /Camera EU/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Camera US/ })).not.toBeInTheDocument()
    expect(screen.getByText('eu/waiting-eu')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Store region' })).toHaveTextContent('Europe')
  })

  it('changes region from the dropdown, with a flag for each, and remembers the choice', async () => {
    serve()
    const user = userEvent.setup()
    renderWithClient(<App />)
    expect(await screen.findByRole('heading', { name: /Camera US/ })).toBeInTheDocument()
    expect(screen.queryByText('eu/waiting-eu')).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Store region' }))
    const list = screen.getByRole('listbox')
    const options = within(list).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['United States', 'Europe', 'Japan'])
    expect(options.every((o) => o.querySelector('img'))).toBe(true)
    await user.click(options[2]!)

    expect(await screen.findByRole('heading', { name: /Camera JP/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Camera US/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('restock-radar.region')).toBe('jp')
  })

  it('works from the keyboard', async () => {
    serve()
    const user = userEvent.setup()
    renderWithClient(<App />)
    await screen.findByRole('heading', { name: /Camera US/ })
    screen.getByRole('combobox', { name: 'Store region' }).focus()
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(await screen.findByRole('heading', { name: /Camera EU/ })).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('is not there when there is only one store', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
    stubFetch({ 'GET /v1/history?days=90': { body: historyResponse() }, 'GET /v1/products': { body: productsResponse() } })
    renderWithClient(<App />)
    await screen.findByRole('heading', { name: /Widget/ })
    expect(screen.queryByRole('combobox', { name: 'Store region' })).not.toBeInTheDocument()
  })
})
