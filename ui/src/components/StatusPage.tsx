import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useCan, useSetSpecsNotExpected, useSpecsGaps, useStatus } from '../api/queries'
import type { Presence, StatusRegion, StatusResponse } from '../api/types'
import { baseSlug } from '../lib/convertPlan'
import { formatExact } from '../lib/format'
import { regionName } from '../lib/region'
import { statusInfo } from '../lib/status'
import { RelativeTime } from './RelativeTime'
import { Card } from './ui/Card'
import { Notice } from './ui/Notice'

const nf = new Intl.NumberFormat()

/** "physical-security-nvr" -> "physical security nvr". */
const categoryName = (id: string) => id.replaceAll('-', ' ')

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let value = n
  let i = -1
  do {
    value /= 1024
    i++
  } while (value >= 1024 && i < units.length - 1)
  return `${value.toFixed(1)} ${units[i]}`
}

function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{children}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  )
}

function Time({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted">never</span>
  return (
    <>
      <time dateTime={iso}>{formatExact(iso)}</time>
      <span className="block text-sm font-normal text-muted">
        <RelativeTime iso={iso} />
      </span>
    </>
  )
}

/** "5 minutes", "1 hour": how often something is read. */
export function every(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? '1 hour' : `${seconds / 3600} hours`
  if (seconds % 60 === 0) return seconds === 60 ? '1 minute' : `${seconds / 60} minutes`
  return `${seconds} seconds`
}

/** What each region holds and how fresh it is, judged against how often that region is read. */
function RegionsCard({ regions }: { regions: StatusRegion[] }) {
  const sum = (pick: (r: StatusRegion) => number) => regions.reduce((n, r) => n + pick(r), 0)
  // The newest of the newest checks, and the stalest of the stalest; null when no region has been checked.
  const extreme = (pick: (r: StatusRegion) => string | null, newest: boolean): string | null =>
    regions.map(pick).filter((t): t is string => t !== null).sort((a, b) => Date.parse(newest ? b : a) - Date.parse(newest ? a : b))[0] ?? null
  const lastCheck = extreme((r) => r.last_check, true)
  const oldestCheck = extreme((r) => r.oldest_check, false)
  const overdue = sum((r) => r.overdue_variants)
  return (
    <Card aria-label="Regions" className="overflow-x-auto sm:col-span-2">
      <h2 className="font-semibold">Regions</h2>
      <table className="mt-2 w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-1.5 pr-3 font-normal">Region</th>
            <th className="px-3 py-1.5 text-right font-normal">Products</th>
            <th className="px-3 py-1.5 text-right font-normal">Variants</th>
            <th className="px-3 py-1.5 text-right font-normal">In stock</th>
            <th className="px-3 py-1.5 text-right font-normal">Categories</th>
            <th className="px-3 py-1.5 font-normal">Read every</th>
            <th className="px-3 py-1.5 font-normal">Newest check</th>
            <th className="py-1.5 pl-3 font-normal">Stalest check</th>
          </tr>
        </thead>
        <tbody>
          {regions.map((r) => (
            <tr key={r.region} className="border-b border-line align-top">
              <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                {regionName(r.region)}
              </th>
              <td className="px-3 py-1.5 text-right tabular-nums">{nf.format(r.products)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{nf.format(r.variants)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{nf.format(r.in_stock)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{nf.format(r.categories)}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">{every(r.read_every_seconds)}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">{r.last_check ? <RelativeTime iso={r.last_check} /> : <span className="text-muted">never</span>}</td>
              <td className="py-1.5 pl-3 whitespace-nowrap">
                {r.oldest_check ? <RelativeTime iso={r.oldest_check} /> : <span className="text-muted">never</span>}
                {r.overdue_variants > 0 && (
                  <span className="block text-bad">
                    {nf.format(r.overdue_variants)} overdue (over {every(r.overdue_after_seconds)})
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line align-top font-semibold">
            <th scope="row" className="py-1.5 pr-3 text-left">
              Total
            </th>
            <td className="px-3 py-1.5 text-right tabular-nums">{nf.format(sum((r) => r.products))}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{nf.format(sum((r) => r.variants))}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{nf.format(sum((r) => r.in_stock))}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{nf.format(sum((r) => r.categories))}</td>
            <td className="px-3 py-1.5" />
            <td className="px-3 py-1.5 font-normal whitespace-nowrap">{lastCheck ? <RelativeTime iso={lastCheck} /> : <span className="text-muted">never</span>}</td>
            <td className="py-1.5 pl-3 font-normal whitespace-nowrap">
              {oldestCheck ? <RelativeTime iso={oldestCheck} /> : <span className="text-muted">never</span>}
              {overdue > 0 && <span className="block font-semibold text-bad">{nf.format(overdue)} overdue</span>}
            </td>
          </tr>
        </tfoot>
      </table>
      <p className="mt-2 text-xs text-muted">A variant is overdue when it has gone unchecked for three of its region's read intervals. A product the store has dropped from a region can stay overdue for good.</p>
    </Card>
  )
}

/** A with/without split as a bar, so coverage reads at a glance. */
function PresenceCard({ title, data, withLabel, withoutLabel, notCheckedLabel }: {
  title: string
  data: Presence
  withLabel: string
  withoutLabel: string
  notCheckedLabel: string
}) {
  const total = data.with + data.without
  const pct = total === 0 ? 0 : Math.round((data.with / total) * 100)
  return (
    <Card aria-label={title}>
      <h2 className="font-semibold">{title}</h2>
      <div
        className="my-3 h-2 overflow-hidden rounded-full bg-line"
        role="meter"
        aria-label={`${title}: ${pct}% ${withLabel}`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={data.with}
      >
        <div className="h-full bg-current" style={{ width: `${pct}%` }} />
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <Stat label={withLabel}>{nf.format(data.with)}</Stat>
        <Stat label={withoutLabel} hint={data.not_checked > 0 ? `${nf.format(data.not_checked)} ${notCheckedLabel}` : undefined}>
          {nf.format(data.without)}
        </Stat>
      </dl>
    </Card>
  )
}

/**
 * The products the store has been read for and published no tech specs, one row for the product in all its regions,
 * with whether none are expected. Those are either products that have none (a cable) or ones whose specs are still to
 * come (newly announced), which is why an editor decides which.
 */
function NoSpecsCard() {
  const { data } = useSpecsGaps()
  const canEdit = useCan('overrides:write')
  const { mark, unmark } = useSetSpecsNotExpected()
  if (!data) return null
  const rows = new Map<string, { slug: string; title: string; regions: { region: string; slug: string }[]; notExpected: boolean }>()
  for (const g of data.products) {
    if (g.fetched_at === null) continue
    const key = baseSlug(g.slug)
    const row = rows.get(key) ?? { slug: key, title: g.title, regions: [], notExpected: g.not_expected }
    row.regions.push({ region: g.region, slug: g.slug })
    rows.set(key, row)
  }
  const list = [...rows.values()]
  if (list.length === 0) return null
  const open = list.filter((r) => !r.notExpected).length
  const error = mark.error ?? unmark.error
  return (
    <Card aria-label="Products with no tech specs" className="sm:col-span-2">
      <h2 className="font-semibold">Products the store publishes no tech specs for</h2>
      <p className="mt-1 text-sm text-muted">
        {nf.format(open)} of {nf.format(list.length)} {list.length === 1 ? 'product is' : 'products are'} not marked as having none to expect. Plans holding an unmarked one are called unsure.
      </p>
      {error && <p role="alert" className="mt-1 text-sm text-bad">{error.message}</p>}
      <ul className="mt-2">
        {list.map((r) => (
          <li key={r.slug} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line py-1.5">
            <span>
              <Link to="/p/$region/$slug" params={r.regions[0]!} className="underline underline-offset-2">
                {r.title}
              </Link>{' '}
              <span className="text-sm text-muted">
                {r.regions.map((x) => regionName(x.region)).join(', ')}
                {r.notExpected ? ' · none expected' : ''}
              </span>
            </span>
            {canEdit && (
              <button
                type="button"
                className="cursor-pointer text-sm underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={mark.isPending || unmark.isPending}
                onClick={() => (r.notExpected ? unmark.mutate(r.slug) : mark.mutate({ slug: r.slug }))}
              >
                {r.notExpected ? 'Expect specs again' : 'None expected'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function StatusContent({ s }: { s: StatusResponse }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const regions = Object.entries(s.regions).sort(([a], [b]) => a.localeCompare(b))
  const multiRegion = regions.length > 1 || new Set(s.categories.map((c) => c.region)).size > 1
  const variantStatuses = Object.entries(s.variants_by_status).sort(([, a], [, b]) => b - a)

  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <Card aria-label="Overview" className="sm:col-span-2">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Tracked products">{nf.format(s.products)}</Stat>
          <Stat label="Variants">{nf.format(s.variants)}</Stat>
          <Stat label="Last synced" hint={tz ? `Shown in ${tz}` : undefined}>
            <Time iso={s.last_sync} />
          </Stat>
          <Stat label="Last poll pass" hint="Since the server started">
            <Time iso={s.last_poll} />
          </Stat>
        </dl>
      </Card>

      {s.by_region.length > 1 && <RegionsCard regions={s.by_region} />}

      <Card aria-label="Categories" className="sm:col-span-2">
        <h2 className="font-semibold">
          Enrolled categories <span className="font-normal text-muted">({s.categories.length})</span>
        </h2>
        {s.categories.length === 0 ? (
          <p className="mt-2 text-muted">No categories enrolled yet.</p>
        ) : (
          <ul className="mt-2 columns-1 gap-8 sm:columns-2">
            {s.categories.map((c) => (
              <li key={`${c.region}/${c.id}`} className="flex break-inside-avoid justify-between gap-3 border-b border-line py-1.5">
                <span>
                  {categoryName(c.id)}
                  {multiRegion && <span className="text-muted"> · {c.region}</span>}
                </span>
                <span className="font-semibold tabular-nums">{nf.format(c.products)}</span>
              </li>
            ))}
          </ul>
        )}
        {s.uncategorized > 0 && (
          <p className="mt-2 text-sm text-muted">
            {nf.format(s.uncategorized)} {s.uncategorized === 1 ? 'product has' : 'products have'} no known category yet.
          </p>
        )}
      </Card>

      <PresenceCard title="Tech specs collected" data={s.specs} withLabel="With specs" withoutLabel="Without specs" notCheckedLabel="not fetched yet" />
      <PresenceCard
        title="techspecs.ui.com page"
        data={s.techspecs_url}
        withLabel="With URL"
        withoutLabel="Without URL"
        notCheckedLabel="not checked yet"
      />
      <NoSpecsCard />

      <Card aria-label="Stock">
        <h2 className="font-semibold">Variants by stock status</h2>
        <ul className="mt-2">
          {variantStatuses.map(([status, n]) => (
            <li key={status} className="flex justify-between border-b border-line py-1.5">
              <span>{statusInfo(status).label}</span>
              <span className="font-semibold tabular-nums">{nf.format(n)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card aria-label="Freshness">
        <h2 className="font-semibold">Freshness</h2>
        <dl className="mt-2 grid grid-cols-2 gap-3">
          <Stat label="Stalest variant check">
            <Time iso={s.oldest_check} />
          </Stat>
          <Stat label="Product pages unread" hint="Not yet read from their own page">
            {nf.format(s.never_detailed)}
          </Stat>
        </dl>
      </Card>

      <Card aria-label="Activity">
        <h2 className="font-semibold">Activity</h2>
        <dl className="mt-2 grid grid-cols-2 gap-3">
          <Stat label="Changes, 24 hours">{nf.format(s.events_24h)}</Stat>
          <Stat label="Changes, 7 days">{nf.format(s.events_7d)}</Stat>
          <Stat label="Notifications pending">{nf.format(s.pending_events)}</Stat>
          <Stat label="Notifications failed">{nf.format(s.failed_events)}</Stat>
        </dl>
        <p className="mt-2 text-sm text-muted">Latest change: {s.latest_event ? <RelativeTime iso={s.latest_event} /> : 'none yet'}</p>
      </Card>

      <Card aria-label="Catalogue">
        <h2 className="font-semibold">Catalogue</h2>
        <dl className="mt-2 grid grid-cols-2 gap-3">
          <Stat label="Watched from config">{nf.format(s.watched_from_config)}</Stat>
          <Stat label="Watched from the UI">{nf.format(s.watched_from_ui)}</Stat>
          <Stat label="Waiting for first check">{nf.format(s.pending_items)}</Stat>
          {s.db_bytes !== null && <Stat label="Database size">{formatBytes(s.db_bytes)}</Stat>}
        </dl>
        {regions.length > 0 && (
          <p className="mt-2 text-sm text-muted">
            Regions: {regions.map(([id, n]) => `${id} (${nf.format(n)})`).join(', ')}
          </p>
        )}
      </Card>
    </div>
  )
}

export default function StatusPage() {
  const { data, isPending, isError, refetch } = useStatus()
  return (
    <main className="mx-auto max-w-6xl px-4 pt-6 pb-12">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Status</h1>
        <a href="/" className="underline">
          ← Restock Radar
        </a>
      </div>
      {isPending && <p className="py-8 text-center text-muted">Loading…</p>}
      {isError && !data && (
        <Notice tone="bad" className="mt-4">
          Couldn't load the status.{' '}
          <button className="cursor-pointer underline" onClick={() => refetch()}>
            Retry
          </button>
        </Notice>
      )}
      {data && <StatusContent s={data} />}
    </main>
  )
}
