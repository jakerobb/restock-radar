import { useCallback, useSyncExternalStore } from 'react'
import { addLine, changeVariant, ensureQty, lineFor, removeLine, replaceLine, setAddOn, setOwned, setQty, type PlanLine } from '../lib/plan'
import { createPlan, deletePlan, getActiveId, getHosting, getPlan, getPlanName, getPlans, getPowering, renamePlan, selectPlan, setHosting, setPlan, setPowering, subscribePlan } from '../lib/planStore'
import type { Powering } from '../lib/powering'
import type { Hosting, HostedRole, HostedWhere } from '../lib/roles'
import type { Product, Variant } from '../api/types'

/** The build plan being edited (one of several, kept in this browser), and the ways to change it. */
export function usePlan() {
  const lines = useSyncExternalStore(subscribePlan, getPlan)
  const hosting = useSyncExternalStore(subscribePlan, getHosting)
  const powering = useSyncExternalStore(subscribePlan, getPowering)
  const name = useSyncExternalStore(subscribePlan, getPlanName)
  const plans = useSyncExternalStore(subscribePlan, getPlans)
  const activeId = useSyncExternalStore(subscribePlan, getActiveId)
  const add = useCallback((line: PlanLine) => setPlan(addLine(getPlan(), line)), [])
  const remove = useCallback((key: string) => setPlan(removeLine(getPlan(), key)), [])
  const changeQty = useCallback((key: string, qty: number) => setPlan(setQty(getPlan(), key, qty)), [])
  const changeOwned = useCallback((key: string, owned: number) => setPlan(setOwned(getPlan(), key, owned)), [])
  const switchVariant = useCallback((key: string, v: Variant) => setPlan(changeVariant(getPlan(), key, v)), [])
  /** Picks which of a product's linked products sits in the plan with it (none, with null). */
  const addOn = useCallback((options: Product[], chosen: Product | null, qty: number) => setPlan(setAddOn(getPlan(), options, chosen, qty)), [])
  /** Sets how a line's switch is powered; for an adapter the store sells separately, the plan gets one for each. */
  const power = useCallback((key: string, code: number, adapter: Product | null, qty: number) => {
    setPowering({ ...getPowering(), [key]: code })
    if (adapter) setPlan(ensureQty(getPlan(), adapter, qty))
  }, [])
  /** Makes a line another product of the same range, with the same quantity and in the same place. */
  const swapProduct = useCallback((key: string, p: Product, qty: number) => {
    const line = lineFor(p, qty)
    if (line) setPlan(replaceLine(getPlan(), key, line))
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
  return { name, plans, activeId, rename: renamePlan, select: selectPlan, create: createPlan, destroy: deletePlan, lines, hosting, powering, power, swapProduct, add, remove, changeQty, changeOwned, switchVariant, addOn, replace, host }
}
