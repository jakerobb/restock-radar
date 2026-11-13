import { filterProducts, groupTags, isInStock, prefixCounts, tagPrefix, matchesQuery, tagCounts, typeCounts } from './filter'
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
  it('keeps only the available variants of products that have any', () => {
    expect(isInStock(inStock)).toBe(true)
    expect(isInStock(soldOut)).toBe(false)
    expect(filterProducts([inStock, soldOut], '', '', [], true)).toEqual([{ ...inStock, variants: [inStock.variants[1]] }])
    expect(filterProducts([inStock, soldOut], '', '')).toEqual([inStock, soldOut])
  })
  it('keeps only the variants whose member product has the chosen tags', () => {
    const a = variant({ id: 'a', tags: ['x'] })
    const b = variant({ id: 'b', tags: ['y'] })
    const group = product({ id: 'g', tags: ['x', 'y'], variants: [a, b] })
    expect(filterProducts([group], '', '', ['x'])).toEqual([{ ...group, tags: ['x'], variants: [a] }])
  })
})

describe('tagCounts with a filtered subset', () => {
  const a = product({ id: 'a', tags: ['x', 'y'] })
  const b = product({ id: 'b', tags: ['x'] })
  const c = product({ id: 'c', tags: ['z'] })
  it('counts only the subset but keeps every tag', () => {
    expect(tagCounts([a, b, c], [a, c])).toEqual([
      { tag: 'x', count: 1 },
      { tag: 'y', count: 1 },
      { tag: 'z', count: 1 },
    ])
    expect(tagCounts([a, b, c], [c])).toEqual([
      { tag: 'z', count: 1 },
      { tag: 'x', count: 0 },
      { tag: 'y', count: 0 },
    ])
  })
})

describe('groupTags', () => {
  it('splits on the first colon and sorts groups by prefix', () => {
    expect(tagPrefix('feature:4k')).toBe('feature')
    expect(tagPrefix('a:b:c')).toBe('a')
    expect(tagPrefix('plain')).toBeNull()
    expect(tagPrefix(':odd')).toBeNull()
    expect(tagPrefix('odd:')).toBeNull()
    const t = (tag: string, count = 1) => ({ tag, count })
    expect(groupTags([t('sale', 3), t('feature:poe', 2), t('color:red'), t('feature:4k')])).toEqual({
      plain: [t('sale', 3)],
      groups: [
        { prefix: 'color', options: [t('color:red')] },
        { prefix: 'feature', options: [t('feature:poe', 2), t('feature:4k')] },
      ],
    })
  })
})

describe('prefixCounts', () => {
  it('counts products once per prefix', () => {
    const a = product({ id: 'a', tags: ['feature:4k', 'feature:poe', 'color:red'] })
    const b = product({ id: 'b', tags: ['feature:4k', 'sale'] })
    expect([...prefixCounts([a, b])]).toEqual([['feature', 2], ['color', 1]])
    expect([...prefixCounts([b])]).toEqual([['feature', 1]])
  })
})

describe('typeCounts with a filtered subset', () => {
  it('counts only the subset but keeps every type', () => {
    expect(typeCounts([camera, gateway, mystery], [gateway])).toEqual([
      { type: 'Cameras & Security', count: 0 },
      { type: 'Gateways', count: 1 },
      { type: 'Other', count: 0 },
    ])
  })
})
