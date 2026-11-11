import { filterProducts, isInStock, matchesQuery, tagCounts, typeCounts } from './filter'
import { product, variant } from '../test/fixtures'

const camera = product({ id: 'a', title: 'Camera G6 180', type: 'Cameras & Security', variants: [variant({ title: 'Black' }), variant({ title: 'White' })] })
const gateway = product({ id: 'b', title: 'Cloud Gateway Fiber', type: 'Gateways', variants: [variant({ title: 'Default' })] })
const mystery = product({ id: 'c', title: 'Mystery Box', type: '' })

describe('matchesQuery', () => {
  it('matches product and variant names, case-insensitively', () => {
    expect(matchesQuery(camera, 'g6')).toBe(true)
    expect(matchesQuery(camera, 'WHITE')).toBe(true)
    expect(matchesQuery(camera, 'gateway')).toBe(false)
  })
  it('needs every word, across product and variant names', () => {
    expect(matchesQuery(camera, 'g6 white')).toBe(true)
    expect(matchesQuery(camera, 'g6 default')).toBe(false)
  })
  it('matches everything when blank', () => expect(matchesQuery(camera, '   ')).toBe(true))
})

describe('matchesQuery extras', () => {
  const unvr = product({ title: 'Network Video Recorder', category: 'physical-security-nvr', variants: [variant({ title: 'Default', sku: 'UNVR' })] })
  const aiKey = product({ title: 'AI Key', category: 'physical-security-nvr', variants: [variant({ title: 'Default', sku: 'AI-KEY' })] })
  const nas = product({ title: 'Network Attached Storage', category: 'network-storage', variants: [variant({ sku: 'UNAS-2' })] })
  it('matches SKUs and category words', () => {
    expect(matchesQuery(unvr, 'unvr')).toBe(true)
    expect(matchesQuery(aiKey, 'nvr')).toBe(true)
    expect(matchesQuery(aiKey, 'physical security')).toBe(true)
    expect(matchesQuery(gateway, 'nvr')).toBe(false)
  })
  it('expands aliases', () => {
    expect(matchesQuery(product({ title: 'Network Video Recorder Pro', variants: [variant({ sku: 'X' })] }), 'nvr')).toBe(true)
    expect(matchesQuery(nas, 'nas')).toBe(true)
    expect(matchesQuery(product({ title: 'Dream Router 7' }), 'gateway')).toBe(true)
  })
})

describe('filterProducts', () => {
  const all = [camera, gateway, mystery]
  it('combines search and type', () => {
    expect(filterProducts(all, '', '')).toEqual(all)
    expect(filterProducts(all, '', 'Gateways')).toEqual([gateway])
    expect(filterProducts(all, '', 'Other')).toEqual([mystery])
    expect(filterProducts(all, 'box', 'Gateways')).toEqual([])
  })
})

describe('typeCounts', () => {
  it('counts per type, alphabetical with Other last', () => {
    expect(typeCounts([mystery, gateway, camera, product({ id: 'd', type: 'Gateways' })])).toEqual([
      { type: 'Cameras & Security', count: 1 },
      { type: 'Gateways', count: 2 },
      { type: 'Other', count: 1 },
    ])
  })
})

describe('tags', () => {
  const sale = product({ id: 's', title: 'AI Port', tags: ['black-friday', 'feature:color-black'] })
  const black = product({ id: 'k', title: 'Dome', tags: ['feature:color-black'] })
  const plain = product({ id: 'n', title: 'Switch', tags: [] })
  const all = [sale, black, plain]

  it('counts every tag, most common first then alphabetical', () => {
    expect(tagCounts(all)).toEqual([
      { tag: 'feature:color-black', count: 2 },
      { tag: 'black-friday', count: 1 },
    ])
    expect(tagCounts([plain])).toEqual([])
  })

  it('narrows to products that have every chosen tag', () => {
    expect(filterProducts(all, '', '', ['black-friday'])).toEqual([sale])
    expect(filterProducts(all, '', '', ['feature:color-black'])).toEqual([sale, black])
    expect(filterProducts(all, '', '', ['feature:color-black', 'black-friday'])).toEqual([sale])
    expect(filterProducts(all, '', '', ['nope'])).toEqual([])
    expect(filterProducts(all, 'dome', '', ['feature:color-black'])).toEqual([black])
  })
})

describe('in stock filter', () => {
  const inStock = product({ id: 'x', variants: [variant({ status: 'SoldOut' }), variant({ status: 'Available' })] })
  const soldOut = product({ id: 'y', variants: [variant({ status: 'SoldOut' })] })
  it('keeps products with any available variant', () => {
    expect(isInStock(inStock)).toBe(true)
    expect(isInStock(soldOut)).toBe(false)
    expect(filterProducts([inStock, soldOut], '', '', [], true)).toEqual([inStock])
    expect(filterProducts([inStock, soldOut], '', '')).toEqual([inStock, soldOut])
  })
})
