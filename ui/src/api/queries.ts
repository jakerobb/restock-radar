import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addItem, getProducts } from './client'

const productsKey = ['products'] as const

/** How often the page re-reads state; the server itself polls every 20 minutes. */
const REFRESH_MS = 30_000

export function useProducts() {
  return useQuery({ queryKey: productsKey, queryFn: getProducts, refetchInterval: REFRESH_MS })
}

export function useAddProduct() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: addItem,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: productsKey }),
  })
}
