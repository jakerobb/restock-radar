import type { ReactNode } from 'react'
import { useStatus } from '../api/queries'
import type { Presence, StatusResponse } from '../api/types'
import { formatExact } from '../lib/format'
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
    <main className="mx-auto max-w-3xl px-4 pt-6 pb-12">
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
