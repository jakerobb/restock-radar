import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithClient, stubFetch } from '../test/render'
import { AddProductForm } from './AddProductForm'

afterEach(() => vi.unstubAllGlobals())

describe('AddProductForm', () => {
  it('sends the input, announces success, and clears the field', async () => {
    const calls = stubFetch({
      'POST /v1/items': { body: { region: 'us', slug: 'ucg-fiber', title: 'Cloud Gateway Fiber', variants: 1, already_tracked: false } },
      'GET /v1/products': { body: { last_sync: null, regions: ['us'], products: [], pending: [] } },
    })
    renderWithClient(<AddProductForm regions={['us']} />)

    const input = screen.getByRole('textbox', { name: /slug or url/i })
    await userEvent.type(input, 'UCG-Fiber')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Now tracking Cloud Gateway Fiber (1 variant).')
    expect(input).toHaveValue('')
    expect(JSON.parse(calls.find((c) => c.key === 'POST /v1/items')!.body!)).toEqual({ item: 'UCG-Fiber' })
  })

  it('reports an already-tracked product', async () => {
    stubFetch({
      'POST /v1/items': { body: { region: 'us', slug: 'x', title: 'X', variants: 1, already_tracked: true } },
      'GET /v1/products': { body: { last_sync: null, regions: ['us'], products: [], pending: [] } },
    })
    renderWithClient(<AddProductForm regions={['us']} />)
    await userEvent.type(screen.getByRole('textbox'), 'x{Enter}')
    expect(await screen.findByRole('status')).toHaveTextContent('X is already tracked.')
  })

  it('shows the server’s reason when it refuses, and clears it on the next keystroke', async () => {
    stubFetch({ 'POST /v1/items': { status: 400, body: { error: 'the us store has no product with slug "nope"' } } })
    renderWithClient(<AddProductForm regions={['us']} />)
    const input = screen.getByRole('textbox')
    await userEvent.type(input, 'nope{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent(`Couldn't add that: the us store has no product with slug "nope".`)
    expect(input).toHaveValue('nope')

    await userEvent.type(input, 's')
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('offers a region picker only when there are several', async () => {
    const { unmount } = renderWithClient(<AddProductForm regions={['us']} />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    unmount()
    renderWithClient(<AddProductForm regions={['us', 'gb']} />)
    expect(screen.getByRole('combobox', { name: 'Region' })).toBeInTheDocument()
  })
})
