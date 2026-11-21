import type { UnifiDeviceInfo } from '../../api/types'
import { product, variant } from '../../test/fixtures'
import { matchDevices } from './match'
import type { FoundDevice } from './types'

const info = (sku: string, shortnames: string[], sysids: string[], name = sku): UnifiDeviceInfo => ({ sku, name, type: 'switch', shortnames, sysids })
const dev = (model: string, over: Partial<FoundDevice> = {}): FoundDevice => ({ model, shortname: '', sysid: '', type: 'usw', ...over })

const infos = [
  info('U7-Pro-XGS', ['U7PROXGS', 'U7-Pro-XGS', 'U7-Pro-XGS-US'], ['a6a4'], 'Access Point U7 Pro XGS'),
  info('USW-Flex-Mini', ['USMINI', 'USW-Flex-Mini', 'USW-Flex-Mini-EU'], ['ed30'], 'Switch Flex Mini'),
  info('USW-Pro-HD-24-PoE', ['USPH24P', 'USW-Pro-HD-24-PoE-EU'], ['ed72'], 'Switch Pro HD 24 PoE'),
  info('USW-Old', ['USOLD'], ['ed99'], 'Switch Old'),
  // Two devices claiming one system id.
  info('Twin-A', [], ['beef']),
  info('Twin-B', [], ['beef']),
]

const products = [
  product({ id: '1', slug: 'u7-pro-xgs', title: 'U7 Pro XGS', variants: [variant({ id: 'a', num: 1, sku: 'U7-Pro-XGS', price_cents: 19900 })] }),
  product({ id: '2', slug: 'usw-flex-mini', title: 'Flex Mini', variants: [variant({ id: 'b', num: 2, sku: 'USW-Flex-Mini', price_cents: 2900 }), variant({ id: 'c', num: 3, sku: 'USW-Flex-Mini-5', title: '5-pack', price_cents: 12900 })] }),
  product({ id: '3', slug: 'pro-hd-24-poe', title: 'Pro HD 24 PoE', variants: [variant({ id: 'd', num: 4, sku: 'USW-Pro-HD-24-PoE-US', price_cents: 79900 })] }),
]

describe('matchDevices', () => {
  it('counts the devices of one kind, whichever of their codes named them, and carries the product and variant', () => {
    const rows = matchDevices(
      [dev('UAPA6A4', { type: 'uap' }), dev('UAPA6A4', { type: 'uap' }), dev('UAPA6A4', { type: 'uap', shortname: 'U7PROXGS', sysid: 'a6a4' })],
      infos,
      products,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'matched', count: 3, title: 'U7 Pro XGS', line: { ref: 'us/u7-pro-xgs', sku: 'U7-Pro-XGS', qty: 3, addedCents: 19900 } })
  })

  it('names the older codes by Ubiquiti’s list of names, and finds the variant of the right SKU among several', () => {
    const [row] = matchDevices([dev('USMINI')], infos, products)
    expect(row?.line?.sku).toBe('USW-Flex-Mini')
  })

  it('finds a product by its SKU without the region the store adds', () => {
    const [row] = matchDevices([dev('USWED72')], infos, products)
    expect(row).toMatchObject({ state: 'matched', title: 'Pro HD 24 PoE', line: { sku: 'USW-Pro-HD-24-PoE-US' } })
  })

  it('says when Ubiquiti knows a device but the store doesn’t list it, and when nothing says what it is', () => {
    const rows = matchDevices([dev('USOLD'), dev('XYZ123'), dev('USWBEEF')], infos, products)
    expect(rows.map((r) => [r.title, r.state])).toEqual([
      ['Switch Old', 'not-tracked'],
      ['USWBEEF', 'unknown'],
      ['XYZ123', 'unknown'],
    ])
  })

  it('lists matches first, then those the store lacks, then the unknown', () => {
    const rows = matchDevices([dev('XYZ123'), dev('USOLD'), dev('UAPA6A4'), dev('USMINI')], infos, products)
    expect(rows.map((r) => r.state)).toEqual(['matched', 'matched', 'not-tracked', 'unknown'])
  })

  it('leaves out a product two of the store’s products answer to, rather than choosing one', () => {
    const twin = [...products, product({ id: '9', slug: 'u7-pro-xgs-b', variants: [variant({ id: 'z', num: 9, sku: 'U7-Pro-XGS' })] })]
    expect(matchDevices([dev('UAPA6A4')], infos, twin)[0]?.state).toBe('unknown')
  })

  it('caps a quantity at what a plan line can hold', () => {
    const many = Array.from({ length: 150 }, () => dev('USMINI'))
    expect(matchDevices(many, infos, products)[0]).toMatchObject({ count: 150, line: { qty: 99 } })
  })
})
