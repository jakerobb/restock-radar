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
    const a = product({ id: 'a', title: 'Gadget Mini', collection: 'g', group: 'Gadgets', variants: [variant({ title: 'Black' })] })
    const b = product({ id: 'b', title: 'Gadget Max', collection: 'g', group: 'Gadgets', variants: [variant({ id: 'v2', title: 'White' })] })
    expect(groupProducts([a, b])[0]!.variants.map((v) => v.title)).toEqual(['Mini – Black', 'Max – White'])
  })
  it('falls back to the first title when nothing is shared, and to full titles when a member is the prefix', () => {
    const a = product({ id: 'a', title: 'UPS 2U', collection: 'u', variants: [variant({ title: 'Default' })] })
    const b = product({ id: 'b', title: 'UPS 2U Pro', collection: 'u', variants: [variant({ id: 'v2', title: 'Default' })] })
    const g = groupProducts([a, b])[0]!
    expect(g.title).toBe('UPS 2U')
    expect(g.variants.map((v) => v.title)).toEqual(['UPS 2U', 'Pro'])
  })
  it('uses the store’s group when the names share nothing', () => {
    const c = product({ id: 'c', title: 'Alpha', collection: 'x', group: 'Greek' })
    const d = product({ id: 'd', title: 'Beta', collection: 'x', group: 'Greek', variants: [variant({ id: 'v3' })] })
    expect(groupProducts([c, d])[0]!.title).toBe('Greek')
  })
  describe('with the store’s groups', () => {
    const cable = (id: string, short: string, group: string) =>
      product({ id, slug: id, title: `${short} (x)`, short_title: short, collection: 'cables', group, variants: [variant({ id: `v-${id}`, title: 'Default', sku: `SKU-${id}` })] })
    const patch = cable('patch', 'UniFi Patch Cable', 'UniFi Patch Cables')
    const outdoor = cable('outdoor', 'UniFi Patch Cable Outdoor', 'UniFi Patch Cables')
    const el = cable('el', 'UniFi Etherlighting Patch Cable', 'UniFi Etherlighting Patch Cables')
    const premium = cable('premium', 'UniFi Premium Patch Cable', 'UniFi Premium Patch Cables')
    const premiumOutdoor = cable('premium-out', 'UniFi Premium Patch Cable Outdoor', 'UniFi Premium Patch Cables')

    it('splits one collection into the store’s groups, naming merged ones by their short titles (a lone product keeps its own title)', () => {
      const out = groupProducts([patch, el, premium, outdoor, premiumOutdoor])
      expect(out.map((p) => p.title)).toEqual(['UniFi Patch Cable', 'UniFi Etherlighting Patch Cable (x)', 'UniFi Premium Patch Cable'])
      expect(out[0]!.variants.map((v) => v.title)).toEqual(['UniFi Patch Cable', 'Outdoor'])
    })
  })
  it('does not merge on a bare shared brand while groups are unknown', () => {
    const a = product({ id: 'a', title: 'UniFi Patch Cable', collection: 'c' })
    const b = product({ id: 'b', title: 'UniFi Etherlighting Patch Cable', collection: 'c' })
    expect(groupProducts([a, b])).toEqual([a, b])
  })
  it('keeps products with and without a known group apart', () => {
    const a = product({ id: 'a', title: 'Power Distribution Pro', collection: 'c', group: 'PDUs' })
    const b = product({ id: 'b', title: 'Power Distribution Hi-Density', collection: 'c' })
    expect(groupProducts([a, b])).toEqual([a, b])
  })
})
