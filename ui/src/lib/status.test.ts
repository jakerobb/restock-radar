import { variant } from '../test/fixtures'
import { statusInfo, summarizeVariants, variantName } from './status'

describe('statusInfo', () => {
  it('maps known statuses', () => {
    expect(statusInfo('Available')).toEqual({ label: 'In stock', tone: 'ok' })
    expect(statusInfo('SoldOut')).toEqual({ label: 'Sold out', tone: 'bad' })
    expect(statusInfo('ComingSoon')).toEqual({ label: 'Coming soon', tone: 'warn' })
  })
  it('passes unknown statuses through as a warning', () => {
    expect(statusInfo('Backordered')).toEqual({ label: 'Backordered', tone: 'warn' })
  })
})

describe('summarizeVariants', () => {
  const inStock = variant({ id: 'a' })
  const soldOut = variant({ id: 'b', status: 'SoldOut' })

  it('summarizes all, none, and some', () => {
    expect(summarizeVariants([inStock, inStock]).label).toBe('In stock')
    expect(summarizeVariants([soldOut, soldOut]).label).toBe('Sold out')
    expect(summarizeVariants([inStock, soldOut])).toEqual({ label: '1 of 2 in stock', tone: 'warn' })
  })

  it('reports a shared status that is not stock-related as itself', () => {
    const soon = variant({ id: 'c', status: 'ComingSoon' })
    expect(summarizeVariants([soon, soon])).toEqual({ label: 'Coming soon', tone: 'warn' })
    expect(summarizeVariants([soon, soldOut])).toEqual({ label: '0 of 2 in stock', tone: 'warn' })
  })
})

describe('variantName', () => {
  it('replaces a "Default" title with the SKU', () => {
    expect(variantName(variant({ title: 'Default', sku: 'UCG-Fiber' }))).toEqual({ title: 'UCG-Fiber' })
  })
  it('keeps real titles and shows the SKU beneath', () => {
    expect(variantName(variant({ title: 'Black', sku: 'X-B' }))).toEqual({ title: 'Black', sku: 'X-B' })
  })
})
