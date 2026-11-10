import { filterProducts, matchesQuery, typeCounts } from './filter'
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
