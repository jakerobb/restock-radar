import { useRegion } from '../hooks/useRegion'
import { regionName } from '../lib/region'
import { planRegionState } from '../lib/regionMismatch'
import { Button } from './ui/Button'
import { Notice } from './ui/Notice'

/**
 * What is added to a plan comes from the picked region's store. When that isn't where most of the plan's products are
 * from, say so, with a way to pick the plan's region. Nothing for a plan that has no lines, or that agrees.
 */
export function PlanRegionNotice({ refs, onSwitched }: { refs: string[]; /** Called once the region has been switched, for a caller that wants to put focus back. */ onSwitched?: () => void }) {
  const { region, setRegion } = useRegion()
  const state = planRegionState(refs, region)
  if ((state.kind !== 'elsewhere' && state.kind !== 'mixed') || state.region === region) return null
  return (
    <Notice tone="warn" className="mt-2 mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
      <div>
        Your region is set to {regionName(region)}, so what you add here comes from its store. Most of this plan is from {regionName(state.region)}.
      </div>
      <Button
        variant="secondary"
        className="ml-auto py-1 text-sm"
        onClick={() => {
          setRegion(state.region)
          onSwitched?.()
        }}
      >
        Switch to {regionName(state.region)}
      </Button>
    </Notice>
  )
}
