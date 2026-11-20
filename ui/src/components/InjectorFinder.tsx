import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import type { Derived, Product } from '../api/types'
import { buildCatalog } from '../lib/catalog'
import { productRef } from '../lib/compare'
import { formatPrice } from '../lib/format'
import { findInjectors, type ListedInjector } from '../lib/injectorFinder'
import { lineFor, type PlanLine } from '../lib/plan'
import type { DerivedLine } from '../lib/planChecks'
import type { Powering } from '../lib/powering'
import { formatSpeed } from '../lib/requirements'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Card } from './ui/Card'

/** "PoE+ · 30 W · 1 GbE": what an injector gives. */
function facts(row: ListedInjector['adds'][number]['row']): string {
  const out = (row.derived?.ports ?? []).find((p) => p.poe_direction === 'out')
  const watts = row.derived?.metrics.find((m) => m.name === 'poe_budget_w')?.value
  return [out?.poe_class, watts !== undefined && `${watts} W`, out && out.max_speed_mbps > 0 && formatSpeed(out.max_speed_mbps)].filter(Boolean).join(' · ')
}

function InjectorRow({ o, label, onAdd }: { o: ListedInjector & { label?: string }; label?: string; onAdd: (lines: PlanLine[], replacing: PlanLine[]) => void }) {
  const text = o.adds.map((a) => `${a.qty > 1 ? `${a.qty} × ` : ''}${a.row.product.title}`).join(' and ')
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-56 text-sm">
        {label && <div className="text-xs font-medium tracking-wide text-muted uppercase">{label}</div>}
        <div className="mt-0.5">
          {o.adds.map((a, i) => (
            <span key={a.row.product.slug}>
              {i > 0 && ' and '}
              {a.qty > 1 && `${a.qty} × `}
              <Link to="/p/$region/$slug" params={{ region: a.row.product.region, slug: a.row.product.slug }} className="text-accent underline-offset-2 hover:underline">
                {a.row.product.title}
              </Link>
            </span>
          ))}
          <span className="ml-2 font-medium tabular-nums">{o.cents === null ? 'n/a' : formatPrice(o.cents, o.currency)}</span>
          <Badge tone={o.inStock ? 'ok' : 'bad'} className="ml-2">
            {o.inStock ? 'In stock' : 'Not in stock'}
          </Badge>
        </div>
        <div className="mt-0.5 text-muted">{o.adds.map((a) => facts(a.row)).join(' and ')}</div>
        {o.slowed > 0 && <div className="mt-0.5 text-muted">{o.slowed === 1 ? 'A device would' : `${o.slowed} devices would`} run slower than {o.slowed === 1 ? 'its' : 'their'} own port.</div>}
        {o.replaces.length > 0 && <div className="mt-0.5 text-muted">Replaces {o.replaces.map((l) => l.view.product?.title ?? l.view.line.ref).join(', ')}, which can't be bought now.</div>}
      </div>
      <Button
        variant="secondary"
        className="shrink-0 py-1 text-sm"
        aria-label={`Add ${text} to the plan`}
        onClick={() => {
          const lines = o.adds.flatMap((a) => lineFor(a.row.product, a.qty) ?? [])
          if (lines.length === o.adds.length) onAdd(lines, o.replaces.map((l) => l.view.line))
        }}
      >
        Add to plan
      </Button>
    </li>
  )
}

/** PoE injectors that, added to the plan, power the devices its switches can't. */
export function InjectorFinder({ plan, products, derived, powering, onAdd, onClose }: { plan: DerivedLine[]; products: Product[]; derived: Derived[]; powering: Powering; onAdd: (lines: PlanLine[], replacing: PlanLine[]) => void; onClose: () => void }) {
  const found = useMemo(() => {
    const byRef = new Map(products.map((p) => [productRef(p), p]))
    return findInjectors(plan, buildCatalog(products, derived), byRef, powering)
  }, [plan, products, derived, powering])
  const extra = found.all.length - found.options.length

  return (
    <Card className="mt-5" aria-label="Find a PoE injector">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">PoE injectors that would power {found.devices === 1 ? 'it' : 'them'}</h2>
        <button type="button" className="cursor-pointer text-sm text-muted underline underline-offset-2 hover:text-ink" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">
        {found.devices === 1 ? 'One device has' : `${found.devices} devices have`} no port with the PoE class and power it needs on a switch. An injector goes between a switch port and the device, so each takes a port of the switch and a wall outlet. Only injectors of a high enough class
        {found.slow ? '' : ' and speed'} are listed.
      </p>
      {found.devices === 0 ? (
        <p className="mt-3 text-sm">Every device now has power.</p>
      ) : found.options.length === 0 ? (
        <p className="mt-3 text-sm">No PoE injector we track would do: either none has the class and speed these devices need, or the switches have no free port to plug them into. A switch with more ports or PoE would.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {found.options.map((o) => (
            <InjectorRow key={o.label} o={o} label={o.label} onAdd={onAdd} />
          ))}
        </ul>
      )}
      {extra > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-muted">{found.all.length} choices would work in all</summary>
          <ul className="mt-1 divide-y divide-line">
            {found.all.map((o) => (
              <InjectorRow key={o.adds.map((a) => `${a.row.product.slug}/${a.qty}`).join('+')} o={o} onAdd={onAdd} />
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}
