import type { AddItemRequest, AddItemResult, Derived, HistoryResponse, Me, OverrideChange, OverrideRequest, ProductSpecsResponse, SpecOverride, SpecsGapsResponse, SpecsNotExpected, ProductsResponse, RefreshResult, StatusResponse, UnifiDevicesResponse } from './types'

/** An error response from the API; message is safe to show to the user. */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed (${res.status})`
    throw new ApiError(message, res.status)
  }
  return body as T
}

export const getProducts = () => request<ProductsResponse>('/v1/products')

export const getStatus = () => request<StatusResponse>('/v1/status')

export const getDerived = () => request<Derived[]>('/v1/derived')

export const getProductSpecs = (region: string, slug: string) =>
  request<ProductSpecsResponse>(`/v1/products/${encodeURIComponent(region)}/${encodeURIComponent(slug)}/specs`)

export const getHistory = (days: number) => request<HistoryResponse>(`/v1/history?days=${days}`)

export const addItem = (req: AddItemRequest) =>
  request<AddItemResult>('/v1/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })

/** Asks the server to read one tracked product from the store now. */
export const refreshProduct = (region: string, slug: string) =>
  request<RefreshResult>(`/v1/products/${encodeURIComponent(region)}/${encodeURIComponent(slug)}/refresh`, { method: 'POST' })

export const getMe = () => request<Me>('/v1/me')

export const putOverride = (req: OverrideRequest) =>
  request<SpecOverride>('/v1/overrides', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })

/** Every override in the database. */
export const getOverrides = () => request<SpecOverride[]>('/v1/overrides')

export const deleteOverride = (id: number) => request<null>(`/v1/overrides/${id}`, { method: 'DELETE' })

export const getOverrideHistory = (region: string, slug: string) =>
  request<OverrideChange[]>(`/v1/overrides/history?region=${encodeURIComponent(region)}&slug=${encodeURIComponent(slug)}`)

export const getSpecsGaps = () => request<SpecsGapsResponse>('/v1/specs/gaps')

/** Says no tech specs are expected for a product (by its slug in any region; it is covered in every region). */
export const markSpecsNotExpected = (slug: string, reason = '') =>
  request<SpecsNotExpected>('/v1/specs/not-expected', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, reason }),
  })

export const unmarkSpecsNotExpected = (slug: string) => request<null>(`/v1/specs/not-expected/${encodeURIComponent(slug)}`, { method: 'DELETE' })

export const getUnifiDevices = () => request<UnifiDevicesResponse>('/v1/unifi-devices')
