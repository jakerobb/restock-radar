import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addItem, getHistory, getProducts } from './client'

const productsKey = ['products'] as const

/** How often the page re-reads state; the server itself polls every 20 minutes. */
const REFRESH_MS = 30_000

export function useProducts() {
  return useQuery({ queryKey: productsKey, queryFn: getProducts, refetchInterval: REFRESH_MS })
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
