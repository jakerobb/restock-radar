import { groupProducts } from './group'
import { product, variant } from '../test/fixtures'

const pro = product({ id: 'pro', slug: 'usp-pdu-pro', title: 'Power Distribution Pro', collection: 'pdu', tags: ['b', 'shared'], variants: [variant({ id: 'v-pro', sku: 'USP-PDU-Pro', title: 'Default' })] })
const hd = product({ id: 'hd', slug: 'usp-pdu-hd', title: 'Power Distribution Hi-Density', collection: 'pdu', tags: ['a', 'shared'], variants: [variant({ id: 'v-hd', sku: 'USP-PDU-HD', title: 'Default', status: 'SoldOut' })] })
const other = product({ id: 'o', title: 'Camera', collection: '' })
const alone = product({ id: 'l', title: 'Lone', collection: 'solo' })

describe('groupProducts', () => {
  it('merges products sharing a collection into one, in the first member’s place', () => {
    const out = groupProducts([other, pro, alone, hd])
    expect(out.map((p) => p.title)).toEqual(['Camera', 'Power Distribution', 'Lone'])
    const group = out[1]!
    expect(group.variants.map((v) => [v.id, v.title, v.sku])).toEqual([
      ['v-pro', 'Pro', 'USP-PDU-Pro'],
      ['v-hd', 'Hi-Density', 'USP-PDU-HD'],
    ])
    expect(group.tags).toEqual(['a', 'b', 'shared'])
    expect(group.url).toBe(pro.url)
  })
  it('leaves standalone and lone-collection products untouched', () => {
    expect(groupProducts([other, alone])).toEqual([other, alone])
  })
  it('does not merge across regions', () => {
    expect(groupProducts([pro, { ...hd, region: 'eu' }])).toHaveLength(2)
  })
  it('keeps a variant’s own name alongside its product’s', () => {
    const a = product({ id: 'a', title: 'Gadget Mini', collection: 'g', variants: [variant({ title: 'Black' })] })
    const b = product({ id: 'b', title: 'Gadget Max', collection: 'g', variants: [variant({ id: 'v2', title: 'White' })] })
    expect(groupProducts([a, b])[0]!.variants.map((v) => v.title)).toEqual(['Mini – Black', 'Max – White'])
  })
  it('falls back to the first title when nothing is shared, and to full titles when a member is the prefix', () => {
    const a = product({ id: 'a', title: 'UPS 2U', collection: 'u', variants: [variant({ title: 'Default' })] })
    const b = product({ id: 'b', title: 'UPS 2U Pro', collection: 'u', variants: [variant({ id: 'v2', title: 'Default' })] })
    const g = groupProducts([a, b])[0]!
    expect(g.title).toBe('UPS 2U')
    expect(g.variants.map((v) => v.title)).toEqual(['UPS 2U', 'Pro'])
    const c = product({ id: 'c', title: 'Alpha', collection: 'x' })
    const d = product({ id: 'd', title: 'Beta', collection: 'x', variants: [variant({ id: 'v3' })] })
    expect(groupProducts([c, d])[0]!.title).toBe('Alpha')
  })
})
