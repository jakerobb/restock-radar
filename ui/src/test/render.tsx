import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { Me } from '../api/types'
import { createAppRouter } from '../router'

/** Renders with a fresh query client that doesn't retry, so failures show up at once. */
export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

/** A fetch stub that answers by "METHOD /path". */
export function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  // Unless a test says otherwise, the server is one where nobody is asked who they are, so everything is allowed.
  routes = { 'GET /v1/me': { body: openMe() }, 'GET /v1/specs/gaps': { body: { products: [], not_expected: [] } }, ...routes }
  const calls: { key: string; body?: string }[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    calls.push({ key, body: init?.body as string | undefined })
    const route = routes[key]
    if (!route) throw new Error(`unexpected request: ${key}`)
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 })
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

/** Renders the whole app at a path (with its query string), returning the router so a test can read the URL. */
export function renderRoute(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, ...utils }
}

/** What GET /v1/me says on a server where identity isn't asked for. */
export function openMe(): Me {
  return { mode: 'open', authenticated: false, open: true, roles: ['admin'], permissions: ['overrides:write', 'products:refresh', 'watchlist:write'] }
}

/** What it says for somebody signed in through a proxy, with the given permissions. */
export function signedInMe(user: string, permissions: Me['permissions']): Me {
  return { mode: 'proxy', authenticated: true, open: false, user, roles: [], permissions }
}

/** What it says for a visitor nobody has vouched for. */
export function anonymousMe(): Me {
  return { mode: 'proxy', authenticated: false, open: false, roles: [], permissions: [] }
}
