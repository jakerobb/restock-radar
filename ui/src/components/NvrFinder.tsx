import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import type { Derived, Product } from '../api/types'
import { buildCatalog } from '../lib/catalog'
import { productRef } from '../lib/compare'
import { formatPrice } from '../lib/format'
import { findNvrs, MAX_NVRS, type ListedNvr } from '../lib/nvrFinder'
import { lineFor, type PlanLine } from '../lib/plan'
import type { DerivedLine } from '../lib/planChecks'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Card } from './ui/Card'

const metric = (d: Derived | null, n: string) => d?.metrics.find((m) => m.name === n)?.value ?? null

function facts(o: ListedNvr): string {
  const poe = metric(o.row.derived, 'poe_budget_w')
  const poePorts = (o.row.derived?.ports ?? []).filter((p) => p.poe_class !== '' && p.poe_direction === 'out').reduce((n, p) => n + p.count, 0)
  return [
    `${Math.round(o.spare * 100)}% of an NVR's camera capacity to spare`,
    poe !== null && `has its own PoE switch: ${poe} W${poePorts > 0 ? ` over ${poePorts} ports` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function NvrRow({ o, label, onAdd }: { o: ListedNvr; label?: string; onAdd: (line: PlanLine, replacing: PlanLine[]) => void }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 text-sm">
        {label && <div className="text-xs font-medium tracking-wide text-muted uppercase">{label}</div>}
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
        {o.alsoGateway && <div className="mt-0.5 text-muted">Also a gateway or console, so it takes on the network too; its camera capacity is lower when it also runs other applications.</div>}
        {o.replaces.length > 0 && <div className="mt-0.5 text-muted">Replaces {o.replaces.map((l) => l.view.product?.title ?? l.view.line.ref).join(', ')}, which can't be bought now.</div>}
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
  )
}

/** NVRs that, added to the plan, have room for its cameras. */
export function NvrFinder({ plan, products, derived, onAdd, onClose }: { plan: DerivedLine[]; products: Product[]; derived: Derived[]; onAdd: (line: PlanLine, replacing: PlanLine[]) => void; onClose: () => void }) {
  const found = useMemo(() => {
    const byRef = new Map(products.map((p) => [productRef(p), p]))
    return findNvrs(plan, buildCatalog(products, derived), byRef)
  }, [plan, products, derived])
  const extra = found.all.length - found.options.length

  return (
    <Card className="mt-5" aria-label="Find an NVR">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">NVRs that would cover it</h2>
        <button type="button" className="cursor-pointer text-sm text-muted underline underline-offset-2 hover:text-ink" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">Each is added to what's already in the plan, so an NVR you have already chosen still counts. Only the number of cameras is considered, not storage.</p>
      {found.options.length === 0 ? (
        <p className="mt-3 text-sm">No NVR we track, even {MAX_NVRS} of one, has room for these cameras.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {found.options.map((o) => (
            <NvrRow key={o.label} o={o} label={o.label} onAdd={onAdd} />
          ))}
        </ul>
      )}
      {extra > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-muted">{found.all.length} NVRs would work in all</summary>
          <ul className="mt-1 divide-y divide-line">
            {found.all.map((o) => (
              <NvrRow key={`${o.row.product.region}/${o.row.product.slug}/${o.qty}`} o={o} onAdd={onAdd} />
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}
