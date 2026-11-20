import { cleanName, DEFAULT_PLAN_NAME, parsePlan, serializeLine, type PlanLine } from './plan'
import type { Powering } from './powering'
import { HOSTED_ROLES, type Hosting } from './roles'

const KEY = 'restock-radar.plans'

/** More plans than anyone keeps; a bound so the list stays a list. */
export const MAX_PLANS = 20

/** A plan, with its name and how its controllers run and its switches are powered. */
export interface NamedPlan {
  id: string
  name: string
  lines: PlanLine[]
  hosting: Hosting
  powering: Powering
}

interface State {
  plans: NamedPlan[]
  /** The id of the plan being edited. */
  active: string
}

let state: State | undefined
const listeners = new Set<() => void>()

const newId = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

const blank = (name = DEFAULT_PLAN_NAME): NamedPlan => ({ id: newId(), name, lines: [], hosting: {}, powering: {} })

function parseHosting(raw: unknown): Hosting {
  const out: Hosting = {}
  if (raw && typeof raw === 'object') for (const role of HOSTED_ROLES) if ((raw as Record<string, unknown>)[role] === 'self') out[role] = 'self'
  return out
}

function parsePowering(raw: unknown): Powering {
  const out: Powering = {}
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 0xffff) out[k] = v
  return out
}

function parsePlans(raw: unknown): State | null {
  if (!raw || typeof raw !== 'object') return null
  const { plans, active } = raw as { plans?: unknown; active?: unknown }
  if (!Array.isArray(plans)) return null
  const out: NamedPlan[] = []
  const ids = new Set<string>()
  for (const p of plans as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || p.id === '' || ids.has(p.id)) continue
    ids.add(p.id)
    out.push({ id: p.id, name: cleanName(p.name) || DEFAULT_PLAN_NAME, lines: parsePlan(p.lines), hosting: parseHosting(p.hosting), powering: parsePowering(p.powering) })
    if (out.length >= MAX_PLANS) break
  }
  const first = out[0]
  if (!first) return null
  return { plans: out, active: out.some((p) => p.id === active) ? (active as string) : first.id }
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? parsePlans(JSON.parse(raw)) : null
    if (parsed) return parsed
  } catch {
    // No storage (a private window, blocked site data) or a damaged value: start with an empty plan.
  }
  const first = blank()
  return { plans: [first], active: first.id }
}

const read = (): State => (state ??= load())

const activePlan = (s: State): NamedPlan => s.plans.find((p) => p.id === s.active) ?? s.plans[0]!

/** Replaces the state. It is kept in memory even when the browser won't store it. */
function commit(next: State): void {
  state = next
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ active: next.active, plans: next.plans.map((p) => ({ id: p.id, name: p.name, lines: p.lines.map(serializeLine), hosting: p.hosting, powering: p.powering })) }),
    )
  } catch {
    // The plans last until the tab closes.
  }
  listeners.forEach((l) => l())
}

function updateActive(change: Partial<Pick<NamedPlan, 'name' | 'lines' | 'hosting' | 'powering'>>): void {
  const s = read()
  commit({ ...s, plans: s.plans.map((p) => (p.id === s.active ? { ...p, ...change } : p)) })
}

/** The plan being edited: its lines. The same array is returned until it changes, as useSyncExternalStore needs. */
export const getPlan = (): PlanLine[] => activePlan(read()).lines

export const setPlan = (next: PlanLine[]): void => updateActive({ lines: next })

/** The controllers the plan runs elsewhere (self-hosted). The same object is returned until it changes. */
export const getHosting = (): Hosting => activePlan(read()).hosting

export const setHosting = (next: Hosting): void => updateActive({ hosting: next })

/** How the plan's switches are powered, by line key. The same object is returned until it changes. */
export const getPowering = (): Powering => activePlan(read()).powering

export const setPowering = (next: Powering): void => updateActive({ powering: next })

/** The name of the plan being edited. */
export const getPlanName = (): string => activePlan(read()).name

/** Renames the plan being edited; a blank name leaves it as it was. */
export function renamePlan(name: string): void {
  const clean = cleanName(name)
  if (clean) updateActive({ name: clean })
}

/** All the plans. The same array is returned until one changes. */
export const getPlans = (): NamedPlan[] => read().plans

export const getActiveId = (): string => read().active

/** Switches to another plan, by id. */
export function selectPlan(id: string): void {
  const s = read()
  if (id !== s.active && s.plans.some((p) => p.id === id)) commit({ ...s, active: id })
}

/** Adds a plan and switches to it; null when there are already as many as there can be. */
export function createPlan(name: string, lines: PlanLine[] = [], hosting: Hosting = {}, powering: Powering = {}): string | null {
  const s = read()
  if (s.plans.length >= MAX_PLANS) return null
  const plan: NamedPlan = { ...blank(cleanName(name) || DEFAULT_PLAN_NAME), lines, hosting, powering }
  commit({ plans: [...s.plans, plan], active: plan.id })
  return plan.id
}

/** Removes the plan being edited and moves to the one before it; the last one left is emptied instead, since there is always a plan. */
export function deletePlan(): void {
  const s = read()
  if (s.plans.length <= 1) {
    updateActive({ lines: [], hosting: {}, powering: {}, name: DEFAULT_PLAN_NAME })
    return
  }
  const at = s.plans.findIndex((p) => p.id === s.active)
  const plans = s.plans.filter((p) => p.id !== s.active)
  commit({ plans, active: plans[Math.max(0, at - 1)]!.id })
}

/** Listens for changes here and, through the storage event, from other tabs. */
export function subscribePlan(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return
    state = undefined
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
  state = undefined
  listeners.clear()
}
