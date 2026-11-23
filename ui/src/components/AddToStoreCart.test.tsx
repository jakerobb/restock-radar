import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { lineFor, viewLine } from '../lib/plan'
import { product, variant } from '../test/fixtures'
import { renderWithClient } from '../test/render'
import { AddToStoreCart } from './AddToStoreCart'

const A = '016bf38c-e845-40c8-8662-32c5e31dc8c1'

const plan = () => {
  const ap = product({ slug: 'u7-pro', title: 'U7 Pro', url: 'https://store.ui.com/us/en/category/wifi/products/u7-pro', variants: [variant({ id: A, sku: 'U7-Pro-US', title: 'U7 Pro' })] })
  const gone = product({ slug: 'gone', title: 'Sold Out Thing', url: 'https://store.ui.com/us/en/products/gone', variants: [variant({ id: '2'.repeat(8) + '-0000-4000-8000-000000000000', sku: 'SO', title: 'Sold Out Thing', status: 'SoldOut' })] })
  const map = new Map([ap, gone].map((p) => [`${p.region}/${p.slug}`, p]))
  return [ap, gone].map((p) => viewLine(lineFor(p, 2)!, map))
}

describe('Add to UniFi cart', () => {
  it('is not offered for an empty plan', () => {
    renderWithClient(<AddToStoreCart name="Empty" views={[]} />)
    expect(screen.queryByRole('button', { name: 'Add to UniFi cart' })).not.toBeInTheDocument()
  })

  it('lists what goes in each store’s cart and what is left out, with a draggable bookmarklet', async () => {
    const user = userEvent.setup()
    renderWithClient(<AddToStoreCart name="Rack" views={plan()} />)
    await user.click(screen.getByRole('button', { name: 'Add to UniFi cart' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/United States store: 1 product, 2 units/)).toBeInTheDocument()
    expect(within(dialog).getByText(/2 × U7 Pro/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Sold Out Thing \(sold out\)/)).toBeInTheDocument()
    // React refuses a javascript: href, so the link has to have got it another way.
    const link = within(dialog).getByText(/Add plan to UniFi cart/).closest('a')!
    expect(link.getAttribute('href')).toMatch(/^javascript:void%20/)
  })

  it('opens the store with the plan in the address’s fragment, and copies it too', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    renderWithClient(<AddToStoreCart name="Rack" views={plan()} />)
    await user.click(screen.getByRole('button', { name: 'Add to UniFi cart' }))
    await user.click(screen.getByRole('button', { name: 'Open the store with this plan' }))
    const [url, target, features] = open.mock.calls[0]!
    expect(String(url).startsWith('https://store.ui.com/us/en#rr=')).toBe(true)
    expect(target).toBe('_blank')
    expect(features).toBe('noopener')
    expect(JSON.parse(decodeURIComponent(String(url).split('#rr=')[1]!))).toEqual({ v: 1, n: 'Rack', r: 'us', i: [[A, 'U7-Pro-US', 2]] })
    expect(write).toHaveBeenCalledWith(decodeURIComponent(String(url).split('#rr=')[1]!))
  })

  describe('when the plan buys from more than one store', () => {
    const EU = '3'.repeat(8) + '-0000-4000-8000-000000000000'
    const both = () => {
      const eu = product({ region: 'eu', slug: 'u7-pro', title: 'U7 Pro EU', url: 'https://eu.store.ui.com/eu/en/products/u7-pro', variants: [variant({ id: EU, sku: 'U7-Pro-EU', title: 'U7 Pro EU', currency: 'EUR' })] })
      const map = new Map([[`eu/u7-pro`, eu]])
      return [...plan(), viewLine(lineFor(eu, 1)!, new Map([...map, ...plan().map((v) => [v.line.ref, v.product!] as const)]))]
    }

    it('offers one store at a time, starting on the one being browsed, and moves the button with the choice', async () => {
      const user = userEvent.setup()
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      renderWithClient(<AddToStoreCart name="Rack" views={both()} region="eu" />)
      await user.click(screen.getByRole('button', { name: 'Add to UniFi cart' }))
      const picker = screen.getByRole('combobox', { name: 'Store' })
      expect(picker).toHaveValue('eu')
      expect(screen.getByText(/Europe store: 1 product/)).toBeInTheDocument()
      expect(screen.queryByText(/United States store/)).not.toBeInTheDocument()

      await user.selectOptions(picker, 'us')
      expect(screen.getByText(/United States store: 1 product, 2 units/)).toBeInTheDocument()
      expect(screen.queryByText(/Europe store/)).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Open the store with this plan' }))
      expect(String(open.mock.calls[0]?.[0]).startsWith('https://store.ui.com/us/en#rr=')).toBe(true)
    })

    it('has no picker for a plan from one store', async () => {
      const user = userEvent.setup()
      renderWithClient(<AddToStoreCart name="Rack" views={plan()} region="us" />)
      await user.click(screen.getByRole('button', { name: 'Add to UniFi cart' }))
      expect(screen.queryByRole('combobox', { name: 'Store' })).not.toBeInTheDocument()
    })
  })
})
