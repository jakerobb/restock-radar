import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'

/** Renders with a fresh query client that doesn't retry, so failures show up at once. */
export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

/** A fetch stub that answers by "METHOD /path". */
export function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
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
