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

  it('summarizes the product and links to the store', () => {
    render(<ProductCard product={multi} showRegion={false} />)
    expect(screen.getByText('1 of 2 in stock')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Camera G6' })).toHaveAttribute('href', multi.url)
  })

  it('strikes through a discounted regular price', () => {
    render(<ProductCard product={multi} showRegion={false} />)
    expect(screen.getByText(/299\.00/).tagName).toBe('S')
    expect(screen.getByRole('row', { name: /White/ })).toHaveTextContent(/249\.00/)
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
