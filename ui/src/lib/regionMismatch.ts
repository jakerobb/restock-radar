/** The region a "region/slug" ref is in. */
export const refRegion = (ref: string): string => ref.split('/')[0] ?? ''

/** How many of the plan's lines are in each region, most first (ties keep the order they were first seen in). */
export function regionCounts(refs: string[]): { region: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const ref of refs) {
    const region = refRegion(ref)
    if (region !== '') counts.set(region, (counts.get(region) ?? 0) + 1)
  }
  return [...counts].map(([region, count]) => ({ region, count })).sort((a, b) => b.count - a.count)
}

/**
 * The region a plan is "in": the one most of its lines are in. When several tie, the picked region if it is one of them,
 * else the first of them seen. A plan with no lines has none.
 */
export function dominantRegion(refs: string[], picked: string): string | undefined {
  const counts = regionCounts(refs)
  const top = counts.filter((c) => c.count === counts[0]?.count)
  return top.find((c) => c.region === picked)?.region ?? top[0]?.region
}

/** What the plan's regions say about it, set against the region the site is showing. */
export type PlanRegionState =
  | { kind: 'none' }
  /** All in the picked region. */
  | { kind: 'match'; region: string }
  /** All in one region, which is not the picked one. */
  | { kind: 'elsewhere'; region: string }
  /** In several regions, whichever is picked. */
  | { kind: 'mixed'; region: string; counts: { region: string; count: number }[] }

export function planRegionState(refs: string[], picked: string): PlanRegionState {
  const counts = regionCounts(refs)
  const region = dominantRegion(refs, picked)
  if (!region) return { kind: 'none' }
  if (counts.length > 1) return { kind: 'mixed', region, counts }
  return region === picked ? { kind: 'match', region } : { kind: 'elsewhere', region }
}
