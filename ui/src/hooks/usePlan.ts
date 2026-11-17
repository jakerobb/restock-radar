import { useCallback, useSyncExternalStore } from 'react'
import { addLine, changeVariant, removeLine, setQty, type PlanLine } from '../lib/plan'
import { getPlan, setPlan, subscribePlan } from '../lib/planStore'
import type { Variant } from '../api/types'

/** The build plan, kept in this browser, and the ways to change it. */
export function usePlan() {
  const lines = useSyncExternalStore(subscribePlan, getPlan)
  const add = useCallback((line: PlanLine) => setPlan(addLine(getPlan(), line)), [])
  const remove = useCallback((key: string) => setPlan(removeLine(getPlan(), key)), [])
  const changeQty = useCallback((key: string, qty: number) => setPlan(setQty(getPlan(), key, qty)), [])
  const switchVariant = useCallback((key: string, v: Variant) => setPlan(changeVariant(getPlan(), key, v)), [])
  const replace = useCallback((next: PlanLine[]) => setPlan(next), [])
  return { lines, add, remove, changeQty, switchVariant, replace }
}
