import { render, screen } from '@testing-library/react'
import { historyResponse, product, variant } from '../test/fixtures'
import { ProductHistory } from './ProductHistory'

const DAY = 86_400_000

describe('ProductHistory', () => {
  const history = historyResponse()
  const until = Date.parse(history.until)
  const iso = (daysAgo: number) => new Date(until - daysAgo * DAY).toISOString()

  const p = product({
    title: 'Camera G6',
    variants: [variant({ id: 'b', title: 'Black' }), variant({ id: 'w', title: 'White' })],
  })

  it('draws one chart per variant, labelled by variant', () => {
    const h = historyResponse({
      variants: [
        {
          region: 'us',
          variant_id: 'b',
          from: iso(20),
          until: history.until,
          points: [
            { time: iso(20), status: 'SoldOut', price_cents: 10000 },
            { time: iso(10), status: 'Available', price_cents: 9000 },
          ],
        },
        { region: 'us', variant_id: 'w', from: iso(5), until: history.until, points: [{ time: iso(5), status: 'ComingSoon', price_cents: null }] },
      ],
    })
    render(<ProductHistory product={p} history={h} />)

    expect(screen.getByText('Last 30 days')).toBeInTheDocument()
    expect(screen.getAllByRole('img', { name: /Camera G6, / })).toHaveLength(2)
    const black = screen.getByRole('img', { name: /Black/ })
    expect(black.querySelectorAll('rect.fill-stock-out')).toHaveLength(1)
    expect(black.querySelectorAll('rect.fill-stock-in')).toHaveLength(1)
    expect(black.querySelectorAll('path')).toHaveLength(1)
    const white = screen.getByRole('img', { name: /White/ })
    expect(white.querySelectorAll('rect.fill-stock-soon')).toHaveLength(1)
    expect(white.querySelectorAll('path')).toHaveLength(0)
  })

  it('skips a variant with no history', () => {
    render(<ProductHistory product={p} history={history} />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
