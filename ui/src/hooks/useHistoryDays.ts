import { useCallback, useState } from 'react'
import { isHistoryRange, readStoredDays, storeDays } from '../lib/historyRange'

/** The chosen history range in days, remembered in browser storage across visits. */
export function useHistoryDays(): [number, (days: number) => void] {
  const [days, setDays] = useState(readStoredDays)
  const choose = useCallback((next: number) => {
    if (!isHistoryRange(next)) return
    setDays(next)
    storeDays(next)
  }, [])
  return [days, choose]
}
