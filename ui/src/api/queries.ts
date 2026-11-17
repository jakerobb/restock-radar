import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addItem, deleteOverride, getDerived, getHistory, getMe, getOverrideHistory, getProductSpecs, getProducts, getStatus, putOverride, refreshProduct } from './client'
import type { OverrideRequest, Permission } from './types'

const productsKey = ['products'] as const

/** How often the page re-reads state; the server itself polls every 5 minutes. */
const REFRESH_MS = 30_000

export function useProducts() {
  return useQuery({ queryKey: productsKey, queryFn: getProducts, refetchInterval: REFRESH_MS })
}

export function useStatus() {
  return useQuery({ queryKey: ['status'], queryFn: getStatus, refetchInterval: REFRESH_MS })
}

/**
 * The last `days` of history. Switching ranges keeps showing the previous range's
 * charts until the new one arrives, so the page never flashes empty.
 */
export function useHistory(days: number) {
  return useQuery({
    queryKey: ['history', days],
    queryFn: () => getHistory(days),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  })
}

export function useAddProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: addItem,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: productsKey }),
  })
}

/** Every product's derived specs. Specs change rarely (the server re-reads them weekly), so this is fetched once and kept. */
export function useDerived() {
  return useQuery({ queryKey: ['derived'], queryFn: getDerived, staleTime: 10 * 60_000 })
}

export function useProductSpecs(region: string, slug: string) {
  return useQuery({ queryKey: ['specs', region, slug], queryFn: () => getProductSpecs(region, slug), staleTime: 60_000 })
}

/**
 * Reads one product from the store now. What came back may differ in price,
 * stock, history and specification, so every view of them is read again.
 */
export function useRefreshProduct(region: string, slug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => refreshProduct(region, slug),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: productsKey }),
        queryClient.invalidateQueries({ queryKey: ['specs', region, slug] }),
        queryClient.invalidateQueries({ queryKey: ['derived'] }),
        queryClient.invalidateQueries({ queryKey: ['history'] }),
      ]),
  })
}

/** Who the server takes the caller to be, and what they may do. */
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: getMe, staleTime: 5 * 60_000, retry: false })
}

/**
 * Whether the caller may do something. False until the server has said so, so a
 * control that would be refused is never offered, even for a moment.
 */
export function useCan(permission: Permission): boolean {
  return useMe().data?.permissions.includes(permission) ?? false
}

/** What changing an override can change: the product's specification, what is derived from it, and the history. */
function useRefreshAfterOverrideChange(region: string, slug: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['specs', region, slug] }),
      queryClient.invalidateQueries({ queryKey: ['derived'] }),
      queryClient.invalidateQueries({ queryKey: ['override-history', region, slug] }),
    ])
}

export function useSaveOverride(region: string, slug: string) {
  const refresh = useRefreshAfterOverrideChange(region, slug)
  return useMutation({ mutationFn: (req: OverrideRequest) => putOverride(req), onSuccess: refresh })
}

export function useDeleteOverride(region: string, slug: string) {
  const refresh = useRefreshAfterOverrideChange(region, slug)
  return useMutation({ mutationFn: (id: number) => deleteOverride(id), onSuccess: refresh })
}

/** The changes made to a product's overrides, newest first; only those who may review them can read it. */
export function useOverrideHistory(region: string, slug: string, enabled: boolean) {
  return useQuery({ queryKey: ['override-history', region, slug], queryFn: () => getOverrideHistory(region, slug), enabled })
}
