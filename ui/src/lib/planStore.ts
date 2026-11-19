import { parsePlan, serializeLine, type PlanLine } from './plan'
import { HOSTED_ROLES, type Hosting } from './roles'

const KEY = 'restock-radar.plan'
const HOSTING_KEY = 'restock-radar.plan-hosting'

let current: PlanLine[] | undefined
let currentHosting: Hosting | undefined
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

function loadHosting(): Hosting {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HOSTING_KEY) ?? '{}')
    const out: Hosting = {}
    if (raw && typeof raw === 'object') for (const role of HOSTED_ROLES) {
      const v = (raw as Record<string, unknown>)[role]
      if (v === 'self') out[role] = v
    }
    return out
  } catch {
    return {}
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

/** The controllers the plan runs elsewhere (self-hosted). The same object is returned until it changes. */
export const getHosting = (): Hosting => (currentHosting ??= loadHosting())

export function setHosting(next: Hosting): void {
  currentHosting = next
  try {
    localStorage.setItem(HOSTING_KEY, JSON.stringify(next))
  } catch {
    // It lasts until the tab closes.
  }
  listeners.forEach((l) => l())
}

/** Listens for changes here and, through the storage event, from other tabs. */
export function subscribePlan(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== HOSTING_KEY && e.key !== null) return
    current = undefined
    currentHosting = undefined
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
  currentHosting = undefined
  listeners.clear()
}
