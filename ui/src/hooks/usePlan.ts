import { useCallback, useSyncExternalStore } from 'react'
import { addLine, changeVariant, ensureQty, removeLine, setAddOn, setQty, type PlanLine } from '../lib/plan'
import { getHosting, getPlan, getPowering, setHosting, setPlan, setPowering, subscribePlan } from '../lib/planStore'
import type { Powering } from '../lib/powering'
import type { Hosting, HostedRole, HostedWhere } from '../lib/roles'
import type { Product, Variant } from '../api/types'

/** The build plan, kept in this browser, and the ways to change it. */
export function usePlan() {
  const lines = useSyncExternalStore(subscribePlan, getPlan)
  const hosting = useSyncExternalStore(subscribePlan, getHosting)
  const powering = useSyncExternalStore(subscribePlan, getPowering)
  const add = useCallback((line: PlanLine) => setPlan(addLine(getPlan(), line)), [])
  const remove = useCallback((key: string) => setPlan(removeLine(getPlan(), key)), [])
  const changeQty = useCallback((key: string, qty: number) => setPlan(setQty(getPlan(), key, qty)), [])
  const switchVariant = useCallback((key: string, v: Variant) => setPlan(changeVariant(getPlan(), key, v)), [])
  /** Picks which of a product's linked products sits in the plan with it (none, with null). */
  const addOn = useCallback((options: Product[], chosen: Product | null, qty: number) => setPlan(setAddOn(getPlan(), options, chosen, qty)), [])
  /** Sets how a line's switch is powered; for an adapter the store sells separately, the plan gets one for each. */
  const power = useCallback((key: string, code: number, adapter: Product | null, qty: number) => {
    setPowering({ ...getPowering(), [key]: code })
    if (adapter) setPlan(ensureQty(getPlan(), adapter, qty))
  }, [])
  /** Replaces the plan, and where its controllers run (nowhere else, unless said). */
  const replace = useCallback((next: PlanLine[], hosted: Hosting = {}, powered: Powering = {}) => {
    setPlan(next)
    setHosting(hosted)
    setPowering(powered)
  }, [])
  /** Runs a controller on your own machine instead of on a product; null to undo. */
  const host = useCallback((role: HostedRole, where: HostedWhere | null) => {
    const next = { ...getHosting() }
    if (where) next[role] = where
    else delete next[role]
    setHosting(next)
  }, [])
  return { lines, hosting, powering, power, add, remove, changeQty, switchVariant, addOn, replace, host }
}
