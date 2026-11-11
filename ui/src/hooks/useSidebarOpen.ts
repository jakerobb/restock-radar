import { useCallback, useState } from 'react'

const KEY = 'restock-radar.sidebar-open'

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'false'
  } catch {
    return true
  }
}

/** Whether the wide-screen filter column is shown, remembered in browser storage across visits. */
export function useSidebarOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(read)
  const toggle = useCallback(() => {
    setOpen((prev) => {
      try {
        localStorage.setItem(KEY, String(!prev))
      } catch {
        // Storage unavailable: the choice just won't be remembered.
      }
      return !prev
    })
  }, [])
  return [open, toggle]
}
