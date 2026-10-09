import { render, screen, within } from '@testing-library/react'
import { indexHistory } from '../lib/history'
import { historyResponse, product, variant } from '../test/fixtures'
import { ProductCard } from './ProductCard'

const DAY = 86_400_000

describe('price and stock charts on a ProductCard', () => {
  const response = historyResponse()
  const until = Date.parse(response.until)
  const iso = (daysAgo: number) => new Date(until - daysAgo * DAY).toISOString()

  const p = product({
    title: 'Camera G6',
    variants: [variant({ id: 'b', title: 'Black' }), variant({ id: 'w', title: 'White' })],
  })
  const history = indexHistory(
    historyResponse({
      ...response,
      variants: [
        {
          region: 'us',
          variant_id: 'b',
          from: iso(20),
          until: response.until,
          points: [
            { time: iso(20), status: 'SoldOut', price_cents: 10000 },
            { time: iso(10), status: 'Available', price_cents: 9000 },
          ],
        },
        { region: 'us', variant_id: 'w', from: iso(5), until: response.until, points: [{ time: iso(5), status: 'ComingSoon', price_cents: null }] },
      ],
    }),
  )

  it('puts each variant chart directly beneath its own row', () => {
    render(<ProductCard product={p} showRegion={false} history={history} />)
    const rows = screen.getAllByRole('row').slice(1) // minus the header row
    expect(rows).toHaveLength(4)
    expect(within(rows[0]!).getByText('Black')).toBeInTheDocument()
    expect(within(rows[1]!).getByRole('img', { name: /Camera G6, Black/ })).toBeInTheDocument()
    expect(within(rows[2]!).getByText('White')).toBeInTheDocument()
    expect(within(rows[3]!).getByRole('img', { name: /Camera G6, White/ })).toBeInTheDocument()
  })

  it('colours the background by stock status and draws the price line', () => {
    render(<ProductCard product={p} showRegion={false} history={history} />)
    const black = screen.getByRole('img', { name: /Black/ })
    expect(black.querySelectorAll('rect.fill-stock-out')).toHaveLength(1)
    expect(black.querySelectorAll('rect.fill-stock-in')).toHaveLength(1)
    expect(black.querySelectorAll('path')).toHaveLength(1)
    const white = screen.getByRole('img', { name: /White/ })
    expect(white.querySelectorAll('rect.fill-stock-soon')).toHaveLength(1)
    expect(white.querySelectorAll('path')).toHaveLength(0)
  })

  it('shows the key, and leaves out a variant that has no history', () => {
    const none = indexHistory(historyResponse())
    render(<ProductCard product={p} showRegion={false} history={none} />)
    expect(screen.getByText('Last 30 days:')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('has no charts or key until history loads', () => {
    render(<ProductCard product={p} showRegion={false} />)
    expect(screen.queryByText('Last 30 days:')).not.toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })
})
