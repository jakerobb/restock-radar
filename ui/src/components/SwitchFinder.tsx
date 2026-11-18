import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import type { Derived, Product } from '../api/types'
import { buildCatalog } from '../lib/catalog'
import { productRef } from '../lib/compare'
import { formatPrice } from '../lib/format'
import { lineFor, type PlanLine } from '../lib/plan'
import type { DerivedLine } from '../lib/planChecks'
import { formatSpeed } from '../lib/requirements'
import { findSwitches, MAX_SWITCHES, type SwitchOption } from '../lib/switchFinder'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Card } from './ui/Card'

function facts(o: SwitchOption): string {
  const { stats } = o
  const parts = [
    stats.spareWatts !== null && `${stats.spareWatts} W of PoE budget to spare`,
    `${stats.sparePorts} PoE ${stats.sparePorts === 1 ? 'port' : 'ports'} spare`,
    stats.slowed === 0 ? 'every device at full speed' : `${stats.slowed} ${stats.slowed === 1 ? 'device' : 'devices'} slowed to ${formatSpeed(stats.slowestMbps ?? 0)} (from ${formatSpeed(stats.slowedFromMbps ?? 0)})`,
  ]
  return parts.filter(Boolean).join(' · ')
}

/** Switches that, added to the plan, give its PoE devices the power and ports they need. */
export function SwitchFinder({ plan, products, derived, onAdd, onClose }: { plan: DerivedLine[]; products: Product[]; derived: Derived[]; onAdd: (line: PlanLine, replacing: PlanLine[]) => void; onClose: () => void }) {
  const found = useMemo(() => {
    const byRef = new Map(products.map((p) => [productRef(p), p]))
    return findSwitches(plan, buildCatalog(products, derived), byRef)
  }, [plan, products, derived])

  return (
    <Card className="mt-5" aria-label="Find a switch">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Switches that would cover it</h2>
        <button type="button" className="cursor-pointer text-sm text-muted underline underline-offset-2 hover:text-ink" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">Each is added to what's already in the plan, with its own PoE budget counted, so a switch you have already chosen still helps.</p>
      {found.options.length === 0 ? (
        <p className="mt-3 text-sm">No switch we track, even {MAX_SWITCHES} of one, gives these devices the power and ports they need. A device may want a higher PoE class than any switch offers.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {found.options.map((o) => (
            <li key={o.label} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 text-sm">
                <div className="text-xs font-medium tracking-wide text-muted uppercase">{o.label}</div>
                <div className="mt-0.5">
                  {o.qty > 1 && `${o.qty} × `}
                  <Link to="/p/$region/$slug" params={{ region: o.row.product.region, slug: o.row.product.slug }} className="text-accent underline-offset-2 hover:underline">
                    {o.row.product.title}
                  </Link>
                  <span className="ml-2 font-medium tabular-nums">{o.cents === null ? 'n/a' : formatPrice(o.cents, o.currency)}</span>
                  <Badge tone={o.inStock ? 'ok' : 'bad'} className="ml-2">
                    {o.inStock ? 'In stock' : 'Not in stock'}
                  </Badge>
                </div>
                <div className="mt-0.5 text-muted">{facts(o)}</div>
                {o.replaces.length > 0 && <div className="mt-0.5 text-muted">Replaces {o.replaces.map((l) => l.view.product?.title ?? l.view.line.ref).join(', ')}, which can't be bought now.</div>}
                {o.partial && <div className="mt-0.5 text-muted">Some devices have no known power draw, so this counts only those that do.</div>}
              </div>
              <Button
                variant="secondary"
                className="py-1 text-sm"
                aria-label={`Add ${o.qty > 1 ? `${o.qty} × ` : ''}${o.row.product.title} to the plan`}
                onClick={() => {
                  const line = lineFor(o.row.product, o.qty)
                  if (line) onAdd(line, o.replaces.map((l) => l.view.line))
                }}
              >
                Add to plan
              </Button>
            </li>
          ))}
        </ul>
      )}
      {found.fitting > found.options.length && <p className="text-xs text-muted">{found.fitting} switches would work in all; these are the ones worth a look.</p>}
    </Card>
  )
}
