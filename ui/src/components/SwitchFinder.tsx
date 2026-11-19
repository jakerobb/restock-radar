import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { Derived, Product } from '../api/types'
import { buildCatalog } from '../lib/catalog'
import { productRef } from '../lib/compare'
import { formatPrice } from '../lib/format'
import { lineFor, type PlanLine } from '../lib/plan'
import type { DerivedLine } from '../lib/planChecks'
import { powerSummary } from '../lib/power'
import type { Powering } from '../lib/powering'
import { formatSpeed } from '../lib/requirements'
import { isFiltering, mountLines, NO_FILTERS } from '../lib/finderFilters'
import { DEFAULT_POWER_METHODS, findFits, MAX_SWITCHES, pickOptions, POWER_METHODS, type ListedSwitch, type PowerMethod } from '../lib/switchFinder'
import { FinderFilterBar, HotSwapBox } from './FinderFilterBar'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Card } from './ui/Card'

function facts(o: ListedSwitch): string {
  const { stats } = o
  const poe = stats.devices > 0
  const parts = [
    poe && stats.spareWatts !== null && `${stats.spareWatts} W of PoE budget to spare`,
    poe && `${stats.sparePorts} PoE ${stats.sparePorts === 1 ? 'port' : 'ports'} spare`,
    stats.netSpare !== null && `${stats.netSpare} switch ${stats.netSpare === 1 ? 'port' : 'ports'} spare`,
    poe && (stats.slowed === 0 ? 'every device at full speed' : `${stats.slowed} ${stats.slowed === 1 ? 'device' : 'devices'} slowed to ${formatSpeed(stats.slowestMbps ?? 0)} (from ${formatSpeed(stats.slowedFromMbps ?? 0)})`),
  ]
  return parts.filter(Boolean).join(' · ')
}

/** One switch (or a few of the same) with its price, stock, how it is powered, how it would sit in the plan, and a way to add it. */
function SwitchRow({ o, label, onAdd }: { o: ListedSwitch; label?: string; onAdd: (lines: PlanLine[], replacing: PlanLine[]) => void }) {
  const parts = [{ row: o.row, qty: o.qty }, ...(o.also ? [o.also] : [])]
  const powers = parts.map((p) => powerSummary(p.row.derived?.power))
  const power = powers.every(Boolean) ? powers.join(' / ') : null
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-56 text-sm">
        {label && <div className="text-xs font-medium tracking-wide text-muted uppercase">{label}</div>}
        <div className="mt-0.5">
          {parts.map((p, i) => (
            <span key={p.row.product.slug}>
              {i > 0 && ' + '}
              {p.qty > 1 && `${p.qty} × `}
              <Link to="/p/$region/$slug" params={{ region: p.row.product.region, slug: p.row.product.slug }} className="text-accent underline-offset-2 hover:underline">
                {p.row.product.title}
              </Link>
            </span>
          ))}
          <span className="ml-2 font-medium tabular-nums">{o.cents === null ? 'n/a' : formatPrice(o.cents, o.currency)}</span>
          <Badge tone={o.inStock ? 'ok' : 'bad'} className="ml-2">
            {o.inStock ? 'In stock' : 'Not in stock'}
          </Badge>
        </div>
        <div className="mt-0.5 text-muted">{facts(o)}</div>
        <div className="mt-0.5 text-muted">{power ? `Powered by ${power}` : 'Power method not specified'}</div>
        {o.mounts.length > 0 && <div className="mt-0.5 text-muted">With {o.mounts.map((m) => `${m.qty > 1 ? `${m.qty} × ` : ''}${m.product.title}`).join(', ')}, which it needs to go in a rack.</div>}
        {o.replaces.length > 0 && <div className="mt-0.5 text-muted">Replaces {o.replaces.map((l) => l.view.product?.title ?? l.view.line.ref).join(', ')}, which can't be bought now.</div>}
        {o.partial && <div className="mt-0.5 text-muted">Some devices have no known power draw, so this counts only those that do.</div>}
      </div>
      <Button
        variant="secondary"
        className="shrink-0 py-1 text-sm"
        aria-label={`Add ${parts.map((p) => `${p.qty > 1 ? `${p.qty} × ` : ''}${p.row.product.title}`).join(' and ')} to the plan`}
        onClick={() => {
          const lines = parts.flatMap((p) => lineFor(p.row.product, p.qty) ?? [])
          if (lines.length === parts.length) onAdd([...lines, ...mountLines(o.mounts)], o.replaces.map((l) => l.view.line))
        }}
      >
        Add to plan
      </Button>
    </li>
  )
}

/** Switches that, added to the plan, give its PoE devices the power and ports they need. */
export function SwitchFinder({ plan, products, derived, powering, onAdd, onClose }: { plan: DerivedLine[]; products: Product[]; derived: Derived[]; powering?: Powering; onAdd: (lines: PlanLine[], replacing: PlanLine[]) => void; onClose: () => void }) {
  const [methods, setMethods] = useState<ReadonlySet<PowerMethod>>(new Set(DEFAULT_POWER_METHODS))
  // Trying every switch is the costly part; the power filter only narrows what it found.
  const [filters, setFilters] = useState(NO_FILTERS)
  const byRef = useMemo(() => new Map(products.map((p) => [productRef(p), p])), [products])
  const fits = useMemo(() => findFits(plan, buildCatalog(products, derived), byRef, powering), [plan, products, derived, byRef, powering])
  // Hot-swappable power supplies are a matter of mains power, so the box is there, and counts, only while AC is accepted.
  const applied = useMemo(() => ({ ...filters, hotSwap: filters.hotSwap && methods.has('ac') }), [filters, methods])
  const found = useMemo(() => pickOptions(fits, methods, applied, byRef), [fits, methods, applied, byRef])
  const toggle = (m: PowerMethod) => setMethods((cur) => new Set(cur.has(m) ? [...cur].filter((x) => x !== m) : [...cur, m]))
  const extra = found.all.length - found.options.length

  return (
    <Card className="mt-5" aria-label="Find a switch">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Switches that would cover it</h2>
        <button type="button" className="cursor-pointer text-sm text-muted underline underline-offset-2 hover:text-ink" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">Each is added to what's already in the plan, with its own PoE budget and ports counted, so a switch you have already chosen still helps.</p>
      <FinderFilterBar filters={filters} onChange={setFilters} hideHotSwap />
      <fieldset className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <legend className="sr-only">Power methods you can use</legend>
        <span className="text-muted" aria-hidden>
          Switch can be powered by:
        </span>
        {POWER_METHODS.map((m) => (
          <label key={m.id} className="inline-flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={methods.has(m.id)} onChange={() => toggle(m.id)} />
            {m.label}
          </label>
        ))}
      </fieldset>
      {methods.has('ac') && (
        <div className="mt-2 text-sm">
          <HotSwapBox filters={filters} onChange={setFilters} />
        </div>
      )}
      {found.options.length === 0 ? (
        <p className="mt-3 text-sm">
          No switch we track{isFiltering(applied) ? ' that fits the filters' : ''}, even {MAX_SWITCHES} of one, gives these devices the power and ports they need
          {found.hidden > 0 ? ` on the power methods you've chosen (${found.hidden} would work on others)` : ''}. A device may want a higher PoE class than any switch offers.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {found.options.map((o) => (
            <SwitchRow key={o.label} o={o} label={o.label} onAdd={onAdd} />
          ))}
        </ul>
      )}
      {extra > 0 ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-muted">
            {found.all.length} {found.all.some((o) => o.also) ? 'options' : 'switches'} would work in all
            {found.hidden > 0 && `; ${found.hidden} more on other power methods`}
          </summary>
          <ul className="mt-1 divide-y divide-line">
            {found.all.map((o) => (
              <SwitchRow key={`${o.row.product.region}/${o.row.product.slug}/${o.qty}/${o.also?.row.product.slug ?? ''}/${o.also?.qty ?? ''}`} o={o} onAdd={onAdd} />
            ))}
          </ul>
        </details>
      ) : (
        found.options.length > 0 && found.hidden > 0 && <p className="mt-2 text-sm text-muted">{found.hidden} more would work on other power methods.</p>
      )}
    </Card>
  )
}
