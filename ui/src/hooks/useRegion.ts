import { useCallback, useSyncExternalStore } from 'react'
import { useProducts } from '../api/queries'
import { pickRegion, readStoredRegion, storeRegion } from '../lib/region'

const listeners = new Set<() => void>()
let chosen: string | null | undefined

function getChosen(): string | null {
  if (chosen === undefined) chosen = readStoredRegion()
  return chosen
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The store region the site is showing, and a way to change it. The choice is
 * kept in browser storage; until one is made, the browser's language decides.
 * `regions` are the ones the server tracks, and a remembered choice that is no
 * longer among them is ignored.
 */
export function useRegion(): { region: string; regions: string[]; setRegion: (id: string) => void } {
  const regions = useProducts().data?.regions ?? []
  const stored = useSyncExternalStore(subscribe, getChosen)
  const setRegion = useCallback((id: string) => {
    chosen = id
    storeRegion(id)
    listeners.forEach((l) => l())
  }, [])
  const region = pickRegion(regions, stored, typeof navigator === 'undefined' ? [] : navigator.languages)
  return { region, regions, setRegion }
}

/** Forgets the choice made in this page load; for tests. */
export function resetRegionChoice(): void {
  chosen = undefined
}
