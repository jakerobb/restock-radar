import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addItem, getHistory, getProducts } from './client'

const productsKey = ['products'] as const

/** How often the page re-reads state; the server itself polls every 20 minutes. */
const REFRESH_MS = 30_000

export function useProducts() {
  return useQuery({ queryKey: productsKey, queryFn: getProducts, refetchInterval: REFRESH_MS })
}

/** How much history the charts show. */
export const HISTORY_DAYS = 30

export function useHistory() {
  return useQuery({ queryKey: ['history', HISTORY_DAYS], queryFn: () => getHistory(HISTORY_DAYS), refetchInterval: REFRESH_MS })
}

export function useAddProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: addItem,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: productsKey }),
  })
}
