import { screen } from '@testing-library/react'
import { openMe, renderRoute, stubFetch } from '../test/render'

afterEach(() => vi.unstubAllGlobals())

describe('AboutPage', () => {
  it('renders at /about', async () => {
    stubFetch({ 'GET /v1/me': { body: openMe() } })
    renderRoute('/about')
    expect(await screen.findByRole('heading', { name: 'About' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Restock Radar/ })).toHaveAttribute('href', '/')
  })
})
