import { useCallback, useState } from 'react'
import { isSortKey, readStoredSort, storeSort, type SortKey } from '../lib/sort'

/** The chosen sort order, remembered in browser storage across visits. */
export function useSort(): [SortKey, (key: SortKey) => void] {
  const [sort, setSort] = useState(readStoredSort)
  const choose = useCallback((next: SortKey) => {
    if (!isSortKey(next)) return
    setSort(next)
    storeSort(next)
  }, [])
  return [sort, choose]
}
