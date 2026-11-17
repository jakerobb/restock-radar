import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addItem, getDerived, getHistory, getProductSpecs, getProducts, getStatus } from './client'

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
