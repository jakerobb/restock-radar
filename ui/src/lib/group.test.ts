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

    it('names variants by their options, qualified by the product unless it is the group’s namesake', () => {
      const a = { ...patch, variants: [variant({ id: 'a1', title: 'White / 0.2 m' })] }
      const b = { ...outdoor, variants: [variant({ id: 'b1', title: 'White / 1 m' })] }
      expect(groupProducts([a, b])[0]!.variants.map((v) => v.title)).toEqual(['White / 0.2 m', 'Outdoor \u2013 White / 1 m'])
    })
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
  describe('when variants would share a name', () => {
    const cabinet = (slug: string, title: string, sku: string) =>
      product({ id: slug, slug, title, short_title: '12U Rack Cabinet', collection: 'racks', group: '12U Rack Cabinets', variants: [variant({ id: `v-${slug}`, sku, title: '' })] })
    const racks = [
      cabinet('450-g', '12U Rack Cabinet, 450 mm, Glass Door', 'R-450-G'),
      cabinet('450-p', '12U Rack Cabinet, 450 mm, Perforated Door', 'R-450-P'),
      cabinet('sw-g', '12U Rack Cabinet, Swing, Glass Door', 'R-SW-G'),
      cabinet('sw-p', '12U Rack Cabinet, Swing, Perforated Door', 'R-SW-P'),
    ]
    it('tells them apart by the full titles, keeping the group’s short name', () => {
      const g = groupProducts(racks)[0]!
      expect(g.title).toBe('12U Rack Cabinet')
      expect(g.variants.map((v) => v.title)).toEqual(['450 mm, Glass Door', '450 mm, Perforated Door', 'Swing, Glass Door', 'Swing, Perforated Door'])
    })
    it('leaves groups whose short titles already differ alone, whatever their full titles say', () => {
      const cover = (id: string, short: string, title: string) =>
        product({ id, slug: id, title, short_title: short, collection: 'covers', group: 'Covers', variants: [variant({ id: `v-${id}`, title: 'Black' })] })
      const g = groupProducts([cover('a', 'U6+ Cover', 'Lite Cover'), cover('b', 'U7 Cover', 'U7 Paintable Cover')])[0]!
      expect(g.variants.map((v) => v.title)).toEqual(['U6+ Cover \u2013 Black', 'U7 Cover \u2013 Black'])
    })
    it('falls back to the SKU where the titles give nothing either', () => {
      const flush = (id: string, sku: string) =>
        product({ id, slug: id, title: 'Flush Mount', short_title: 'Flush Mount', collection: 'f', group: 'Flush Mounts', variants: [variant({ id: `v-${id}`, sku, title: 'Black' })] })
      const g = groupProducts([flush('a', 'FM-B'), flush('b', 'FMS-B')])[0]!
      expect(g.variants.map((v) => v.title)).toEqual(['Black (FM-B)', 'Black (FMS-B)'])
    })
  })
})
