import { describe, expect, it } from 'vitest'
import type { Product } from '../api/types'
import { sortProducts } from './sort'

function product(title: string, price: number | null, seen: string, changed: string): Product {
  return {
    region: 'us',
    id: title,
    slug: title,
    title,
    type: '',
    category: '',
    url: '',
    variants: [
      {
        id: title, sku: title, title: 'Default', status: 'Available', price_cents: price, regular_price_cents: null,
        currency: 'USD', last_checked: changed, last_changed: changed, first_seen: seen,
      },
    ],
  }
}

const a = product('Apple', 3000, '2026-01-02T00:00:00Z', '2026-03-01T00:00:00Z')
const b = product('Banana', 1000, '2026-01-03T00:00:00Z', '2026-02-01T00:00:00Z')
const c = product('Cherry', null, '2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z')
const titles = (ps: Product[]) => ps.map((p) => p.title)

describe('sortProducts', () => {
  it('sorts by name', () => expect(titles(sortProducts([c, b, a], 'name'))).toEqual(['Apple', 'Banana', 'Cherry']))
  it('sorts newest added first', () => expect(titles(sortProducts([a, b, c], 'date'))).toEqual(['Banana', 'Apple', 'Cherry']))
  it('sorts most recently updated first', () => expect(titles(sortProducts([a, b, c], 'updated'))).toEqual(['Cherry', 'Apple', 'Banana']))
  it('sorts price ascending with unpriced last', () => expect(titles(sortProducts([c, a, b], 'price-asc'))).toEqual(['Banana', 'Apple', 'Cherry']))
  it('sorts price descending with unpriced last', () => expect(titles(sortProducts([c, b, a], 'price-desc'))).toEqual(['Apple', 'Banana', 'Cherry']))
  it('does not mutate its input', () => {
    const input = [c, b, a]
    sortProducts(input, 'name')
    expect(titles(input)).toEqual(['Cherry', 'Banana', 'Apple'])
  })
})
