import { useRefreshProduct } from '../api/queries'
import type { RefreshResult } from '../api/types'
import { Button } from './ui/Button'

/** One line saying what a refresh found. */
export function describeRefresh(r: RefreshResult): string {
  const parts = ['Refreshed.']
  if (r.spec_entries === 0) parts.push("The store doesn't publish a specification for it yet.")
  else parts.push(r.specs_changed ? 'The specification changed.' : 'The specification is unchanged.')
  if (r.events > 0) parts.push(`${r.events} price or stock ${r.events === 1 ? 'change' : 'changes'} recorded; notifications go out with the next poll.`)
  return parts.join(' ')
}

/** Reads the product from the store now instead of waiting for the next scheduled read. */
export function RefreshButton({ region, slug }: { region: string; slug: string }) {
  const refresh = useRefreshProduct(region, slug)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button type="button" variant="secondary" className="px-3 text-sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
        {refresh.isPending ? 'Refreshing…' : 'Refresh from store'}
      </Button>
      {refresh.isSuccess && (
        <span role="status" className="text-sm text-muted">
          {describeRefresh(refresh.data)}
        </span>
      )}
      {refresh.isError && (
        <span role="alert" className="text-sm text-bad">
          {refresh.error.message}
        </span>
      )}
    </div>
  )
}
