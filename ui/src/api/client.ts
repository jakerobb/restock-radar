import type { AddItemRequest, AddItemResult, ProductsResponse } from './types'

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

export const addItem = (req: AddItemRequest) =>
  request<AddItemResult>('/v1/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
