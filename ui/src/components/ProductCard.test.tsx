import { render, screen, within } from '@testing-library/react'
import { product, variant } from '../test/fixtures'
import { ProductCard } from './ProductCard'

describe('ProductCard', () => {
  const multi = product({
    title: 'Camera G6',
    variants: [
      variant({ id: 'b', sku: 'G6-B', title: 'Black' }),
      variant({ id: 'w', sku: 'G6-W', title: 'White', status: 'SoldOut', price_cents: 24900, regular_price_cents: 29900 }),
    ],
  })

  it('groups every variant under one product heading', () => {
    render(<ProductCard product={multi} showRegion={false} />)
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    const rows = screen.getAllByRole('row').slice(1) // minus the header row
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Black')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('White')).toBeInTheDocument()
  })

  it('summarizes the product, with the title linking to its details and a Store link out', () => {
    render(<ProductCard product={multi} showRegion={false} />)
    expect(screen.getByText('1 of 2 in stock')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Camera G6' })).toHaveAttribute('href', `/p/${multi.region}/${multi.slug}`)
    expect(screen.getByRole('link', { name: 'Store' })).toHaveAttribute('href', multi.url)
    expect(screen.queryByRole('link', { name: 'Details' })).not.toBeInTheDocument()
  })

  it('leaves out the heading badge for a single variant, whose row says the same, and the title linking to the store on its own page', () => {
    const one = product({ title: 'UPS 2U', variants: [variant({ id: 'u', sku: 'UPS-2U-US', title: 'UPS-2U-US', status: 'SoldOut' })] })
    const { rerender } = render(<ProductCard product={one} showRegion={false} />)
    expect(within(screen.getByRole('heading')).queryByText(/stock|Sold out/i)).not.toBeInTheDocument()
    expect(screen.getAllByText('Sold out')).toHaveLength(1) // the row's
    expect(screen.queryByText('Variant')).not.toBeInTheDocument() // nor a column of SKUs
    expect(screen.getByRole('link', { name: 'UPS 2U' })).toHaveAttribute('href', `/p/${one.region}/${one.slug}`)
    rerender(<ProductCard product={one} showRegion={false} onPage />)
    expect(screen.getByRole('link', { name: 'UPS 2U' })).toHaveAttribute('href', one.url)
  })

  it('links to the tech specs page, when there is one', () => {
    const { rerender } = render(<ProductCard product={multi} showRegion={false} />)
    expect(screen.getByRole('link', { name: 'Tech specs' })).toHaveAttribute('href', multi.techspecs_url)
    rerender(<ProductCard product={{ ...multi, techspecs_url: '' }} showRegion={false} />)
    expect(screen.queryByRole('link', { name: 'Tech specs' })).not.toBeInTheDocument()
  })

  it('strikes through a discounted regular price', () => {
    render(<ProductCard product={multi} showRegion={false} />)
    expect(screen.getByText(/299/).tagName).toBe('S')
    expect(screen.getByRole('row', { name: /White/ })).toHaveTextContent(/\$249/)
  })

  it('shows the price with surcharges as the main price, with the breakdown beneath', () => {
    const p = product({
      variants: [variant({ price_cents: 129900, price_with_surcharges_cents: 143100, surcharge_types: ['Memory'] })],
    })
    render(<ProductCard product={p} showRegion={false} />)
    const row = screen.getByRole('row', { name: /Black/ })
    expect(within(row).getByText('$1,431')).toBeInTheDocument()
    expect(within(row).getByText('$1,299 base price')).toBeInTheDocument()
    expect(within(row).getByText('+ $132 memory surcharge')).toBeInTheDocument()
  })

  it('breaks a sale price with surcharges into struck base price, sale price and surcharge', () => {
    const p = product({
      variants: [variant({ price_cents: 15900, regular_price_cents: 19900, price_with_surcharges_cents: 17500, surcharge_types: ['Memory'] })],
    })
    render(<ProductCard product={p} showRegion={false} />)
    const row = screen.getByRole('row', { name: /Black/ })
    expect(within(row).getByText('$175')).toBeInTheDocument()
    expect(within(row).getByText('$199 base price').tagName).toBe('S')
    expect(within(row).getByText('$159 sale price')).toBeInTheDocument()
    expect(within(row).getByText('+ $16 memory surcharge')).toBeInTheDocument()
  })

  it('shows the restock ETA of a sold-out variant', () => {
    const p = product({ variants: [variant({ status: 'SoldOut', restock_eta: '2026-11-18' })] })
    render(<ProductCard product={p} showRegion={false} />)
    expect(screen.getByText(/restock 2026-11-18/)).toBeInTheDocument()
  })

  it('labels the region only when asked', () => {
    const { rerender } = render(<ProductCard product={multi} showRegion={false} />)
    expect(screen.queryByText('us')).not.toBeInTheDocument()
    rerender(<ProductCard product={multi} showRegion />)
    expect(screen.getByText('us')).toBeInTheDocument()
  })
})
