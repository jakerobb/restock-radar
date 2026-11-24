import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getPlan, getPlans } from '../lib/planStore'
import * as importer from '../lib/unifiImport'
import { product, variant } from '../test/fixtures'
import { renderWithClient, stubFetch } from '../test/render'
import { ImportUnifi } from './ImportUnifi'

vi.mock('../lib/unifiImport', async (original) => ({ ...(await original<typeof import('../lib/unifiImport')>()), readUnifiFile: vi.fn() }))

const products = [product({ id: '1', slug: 'u7-pro-xgs', title: 'U7 Pro XGS', variants: [variant({ id: 'a', num: 1, sku: 'U7-Pro-XGS', price_cents: 19900 })] })]
const devices = [
  { sku: 'U7-Pro-XGS', name: 'Access Point U7 Pro XGS', type: 'access-point', shortnames: ['U7PROXGS'], sysids: ['a6a4'] },
  { sku: 'USW-Old', name: 'Switch Old', type: 'switch', shortnames: ['USOLD'], sysids: ['ed99'] },
]
const found = [
  { model: 'UAPA6A4', shortname: '', sysid: '', type: 'uap' },
  { model: 'UAPA6A4', shortname: '', sysid: '', type: 'uap' },
  { model: 'USOLD', shortname: '', sysid: '', type: 'usw' },
]

describe('ImportUnifi', () => {
  it('reads the file here, asks the server only for the public device list, and makes a new plan of what matched', async () => {
    vi.mocked(importer.readUnifiFile).mockResolvedValue(found)
    const calls = stubFetch({ 'GET /v1/unifi-devices': { body: { devices } } })
    const user = userEvent.setup()
    renderWithClient(<ImportUnifi products={products} region="us" />)

    await user.click(screen.getByRole('button', { name: 'Import from UniFi' }))
    await user.upload(screen.getByLabelText('File'), new File(['x'], 'support.tgz'))

    expect(await screen.findByText('U7 Pro XGS')).toBeInTheDocument()
    expect(screen.getByText(/Switch Old/)).toBeInTheDocument()
    expect(screen.getByText(/isn’t one this store lists/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create a plan of 2 devices' }))
    expect(getPlan()).toEqual([{ ref: 'us/u7-pro-xgs', sku: 'U7-Pro-XGS', qty: 2, addedCents: 19900, owned: 2 }])
    expect(getPlans().map((p) => p.name)).toContain('UniFi import')

    // Nothing of the file went anywhere: the only request is the public list, with no body.
    expect(calls).toEqual([{ key: 'GET /v1/unifi-devices', body: undefined }])
  })

  it('leaves out a row that is unticked', async () => {
    vi.mocked(importer.readUnifiFile).mockResolvedValue(found)
    stubFetch({ 'GET /v1/unifi-devices': { body: { devices } } })
    const user = userEvent.setup()
    renderWithClient(<ImportUnifi products={products} region="us" />)
    await user.click(screen.getByRole('button', { name: 'Import from UniFi' }))
    await user.upload(screen.getByLabelText('File'), new File(['x'], 'support.tgz'))
    await user.click(await screen.findByLabelText('Include U7 Pro XGS'))
    expect(screen.getByRole('button', { name: /Create a plan/ })).toBeDisabled()
  })

  it('shows what is wrong with a file', async () => {
    vi.mocked(importer.readUnifiFile).mockRejectedValue(new importer.ImportError('That is a UniFi OS backup (.unifi) of the whole console.'))
    stubFetch({})
    const user = userEvent.setup()
    renderWithClient(<ImportUnifi products={products} region="us" />)
    await user.click(screen.getByRole('button', { name: 'Import from UniFi' }))
    await user.upload(screen.getByLabelText('File'), new File(['x'], 'a.unifi'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('UniFi OS backup'))
  })
})
