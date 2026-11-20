import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { product, variant } from '../test/fixtures'
import { ConvertPlan } from './ConvertPlan'

const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

/** `n` products the EU store sells under a regional SKU, and `m` it doesn't sell at all. */
function setup(n: number, m: number) {
  const products = [
    ...many(n).flatMap((i) => [
      product({
        region: 'us',
        id: `s${i}`,
        slug: `s${i}`,
        title: `Sold ${i}`,
        variants: [variant({ sku: `S${i}` })],
      }),
      product({
        region: 'eu',
        id: `s${i}`,
        slug: `s${i}`,
        title: `Sold ${i}`,
        variants: [variant({ sku: `S${i}-EU` })],
      }),
    ]),
    ...many(m).map((i) =>
      product({
        region: 'us',
        id: `m${i}`,
        slug: `m${i}`,
        title: `Missing ${i}`,
        variants: [variant({ sku: `M${i}` })],
      }),
    ),
  ]
  const lines = products
    .filter((p) => p.region === 'us')
    .map((p) => ({
      ref: `us/${p.slug}`,
      sku: p.variants[0]!.sku,
      qty: 1,
      addedCents: null,
    }))
  render(<ConvertPlan name="Rack" lines={lines} hosting={{}} powering={{}} products={products} regions={['us', 'eu']} suggested="eu" />)
}

describe('ConvertPlan', () => {
  it('lists each renamed SKU on its own line, with an arrow', async () => {
    setup(2, 0)
    await userEvent.click(screen.getByRole('button', { name: 'Convert to another region' }))
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(['Sold 1S1 → S1-EU', 'Sold 2S2 → S2-EU'])
  })

  it('lists each left-out line on its own line', async () => {
    setup(0, 2)
    await userEvent.click(screen.getByRole('button', { name: 'Convert to another region' }))
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(['Missing 1 is not sold there', 'Missing 2 is not sold there'])
  })

  it('scrolls a long list rather than growing the dialog', async () => {
    setup(12, 12)
    await userEvent.click(screen.getByRole('button', { name: 'Convert to another region' }))
    const lists = within(screen.getByRole('dialog')).getAllByRole('list')
    expect(lists).toHaveLength(2)
    for (const list of lists) expect(list).toHaveClass('max-h-[12.5rem]', 'overflow-y-auto')
  })
})
