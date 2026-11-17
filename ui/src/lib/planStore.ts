import { parsePlan, serializeLine, type PlanLine } from './plan'

const KEY = 'restock-radar.plan'

let current: PlanLine[] | undefined
const listeners = new Set<() => void>()

function load(): PlanLine[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? parsePlan(JSON.parse(raw)) : []
  } catch {
    // No storage (a private window, blocked site data) or a damaged value: start with an empty plan.
    return []
  }
}

/** The plan. The same array is returned until it changes, as useSyncExternalStore needs. */
export const getPlan = (): PlanLine[] => (current ??= load())

/** Replaces the plan. It is kept in memory even when the browser won't store it. */
export function setPlan(next: PlanLine[]): void {
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next.map(serializeLine)))
  } catch {
    // The plan lasts until the tab closes.
  }
  listeners.forEach((l) => l())
}

/** Listens for changes here and, through the storage event, from other tabs. */
export function subscribePlan(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return
    current = undefined
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** For tests: forget what was loaded. */
export function resetPlanStore(): void {
  current = undefined
  listeners.clear()
}
