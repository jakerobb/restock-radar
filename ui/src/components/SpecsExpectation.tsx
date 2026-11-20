import { useCan, useSetSpecsNotExpected, useSpecsGaps } from '../api/queries'
import { baseSlug } from '../lib/convertPlan'
import { notExpectedSlugs } from '../lib/specsGaps'
import { Button } from './ui/Button'

/**
 * Where a product has no tech specs: says so, and lets an editor say none are expected for it (a cable, a bracket),
 * so a plan holding it isn't called unsure for want of them. The mark is by the product's slug without its region
 * suffix, so it covers the product in every region. Shows nothing for a product that has specs, or that hasn't been
 * read from the store yet (it may just not be collected).
 */
export function SpecsExpectation({ region, slug }: { region: string; slug: string }) {
  const { data } = useSpecsGaps()
  const canEdit = useCan('overrides:write')
  const { mark, unmark } = useSetSpecsNotExpected()
  if (!data) return null

  const marked = notExpectedSlugs(data).has(baseSlug(slug))
  const gap = data.products.find((g) => g.region === region && g.slug === slug)
  const entry = data.not_expected.find((e) => e.slug === baseSlug(slug))
  const error = mark.error ?? unmark.error

  if (marked) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span>
          No tech specs are expected for this product (in any region){entry?.reason ? `: ${entry.reason}` : ''}. Plans holding it aren't called unsure for lack of them.
        </span>
        {canEdit && (
          <Button type="button" variant="secondary" className="px-3 text-sm" disabled={unmark.isPending} onClick={() => unmark.mutate(slug)}>
            {unmark.isPending ? 'Removing…' : 'Expect specs again'}
          </Button>
        )}
        {error && <span role="alert" className="text-bad">{error.message}</span>}
      </div>
    )
  }
  if (!gap || gap.fetched_at === null) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <span>
        {gap.published
          ? "What the store publishes for this product gives the plan checks nothing to use (its specs may be laid out per variant), so they can't tell what it needs."
          : "The store publishes no tech specs for this product, so plan checks can't tell what it needs."}{' '}
        A plan holding it is called unsure.
      </span>
      {canEdit && (
        <Button type="button" variant="secondary" className="px-3 text-sm" disabled={mark.isPending} onClick={() => mark.mutate({ slug })}>
          {mark.isPending ? 'Saving…' : 'No specs expected for this'}
        </Button>
      )}
      {error && <span role="alert" className="text-bad">{error.message}</span>}
    </div>
  )
}
