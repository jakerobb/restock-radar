import { useCallback, useSyncExternalStore } from 'react'
import { addLine, changeVariant, removeLine, setQty, type PlanLine } from '../lib/plan'
import { getHosting, getPlan, setHosting, setPlan, subscribePlan } from '../lib/planStore'
import type { Hosting, HostedRole, HostedWhere } from '../lib/roles'
import type { Variant } from '../api/types'

/** The build plan, kept in this browser, and the ways to change it. */
export function usePlan() {
  const lines = useSyncExternalStore(subscribePlan, getPlan)
  const hosting = useSyncExternalStore(subscribePlan, getHosting)
  const add = useCallback((line: PlanLine) => setPlan(addLine(getPlan(), line)), [])
  const remove = useCallback((key: string) => setPlan(removeLine(getPlan(), key)), [])
  const changeQty = useCallback((key: string, qty: number) => setPlan(setQty(getPlan(), key, qty)), [])
  const switchVariant = useCallback((key: string, v: Variant) => setPlan(changeVariant(getPlan(), key, v)), [])
  /** Replaces the plan, and where its controllers run (nowhere else, unless said). */
  const replace = useCallback((next: PlanLine[], hosted: Hosting = {}) => {
    setPlan(next)
    setHosting(hosted)
  }, [])
  /** Runs a controller in the cloud or on your own machine instead of on a product; null to undo. */
  const host = useCallback((role: HostedRole, where: HostedWhere | null) => {
    const next = { ...getHosting() }
    if (where) next[role] = where
    else delete next[role]
    setHosting(next)
  }, [])
  return { lines, hosting, add, remove, changeQty, switchVariant, replace, host }
}
