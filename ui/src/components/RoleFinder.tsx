import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import type { Derived, Product } from '../api/types'
import { buildCatalog } from '../lib/catalog'
import { productRef } from '../lib/compare'
import { formatPrice } from '../lib/format'
import { lineFor, type PlanLine } from '../lib/plan'
import type { DerivedLine } from '../lib/planChecks'
import { findRoles, type ListedRole } from '../lib/roleFinder'
import { appsRun, gatewayLabel, ROLE_LABEL } from '../lib/roles'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Card } from './ui/Card'

const APP_LABEL: Record<string, string> = { network: 'Network', protect: 'Protect', access: 'Access', talk: 'Talk' }

/** What a product does, one thing after another: "5 Gbps gateway, Network controller (50+ devices), Protect controller". */
function roles(r: ListedRole['rows'][number]): string {
  const count = (name: string, noun: string) => {
    const m = r.derived?.metrics.find((x) => x.name === name)
    return m && m.value > 0 ? ` (${m.value.toLocaleString('en-US')}${m.at_least ? '+' : ''} ${noun})` : ''
  }
  const parts = [r.product.type === 'Gateways' ? gatewayLabel(r.derived) : null, ...appsRun(r.derived).map((a) => `${APP_LABEL[a]} controller${a === 'network' ? count('managed_devices', 'devices') : a === 'access' ? count('managed_access_hubs', 'hubs') : ''}`)]
  return `${r.product.title}: ${parts.filter(Boolean).join(', ') || 'no applications listed'}`
}

function RoleRow({ o, label, onAdd }: { o: ListedRole; label?: string; onAdd: (lines: PlanLine[], replacing: PlanLine[]) => void }) {
  const title = o.rows.map((r) => r.product.title).join(' and ')
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 text-sm">
        {label && <div className="text-xs font-medium tracking-wide text-muted uppercase">{label}</div>}
        <div className="mt-0.5">
          {o.rows.map((r, i) => (
            <span key={productRef(r.product)}>
              {i > 0 && ' + '}
              <Link to="/p/$region/$slug" params={{ region: r.product.region, slug: r.product.slug }} className="text-accent underline-offset-2 hover:underline">
                {r.product.title}
              </Link>
            </span>
          ))}
          <span className="ml-2 font-medium tabular-nums">{o.cents === null ? 'n/a' : formatPrice(o.cents, o.currency)}</span>
          <Badge tone={o.inStock ? 'ok' : 'bad'} className="ml-2">
            {o.inStock ? 'In stock' : 'Not in stock'}
          </Badge>
        </div>
        <div className="mt-0.5 text-muted">
          {o.rows.map(roles).join(' · ')}
        </div>
        {o.unverified && <div className="mt-0.5 text-muted">The store doesn't say how many devices it manages, so it can't be shown to manage the plan's.</div>}
        {o.replaces.length > 0 && (
          <div className="mt-0.5 text-muted">
            Replaces {o.replaces.map((l) => l.view.product?.title ?? l.view.line.ref).join(', ')}, which {o.replaces.every((l) => o.undersized.includes(l)) ? 'manages too few devices for the plan' : o.replaces.some((l) => o.undersized.includes(l)) ? "can't be bought now or manages too few devices for the plan" : "can't be bought now"}.
          </div>
        )}
      </div>
      <Button
        variant="secondary"
        className="py-1 text-sm"
        aria-label={`Add ${title} to the plan`}
        onClick={() => {
          const lines = o.rows.flatMap((r) => lineFor(r.product, 1) ?? [])
          if (lines.length === o.rows.length) onAdd(lines, o.replaces.map((l) => l.view.line))
        }}
      >
        Add to plan
      </Button>
    </li>
  )
}

/** Products that, added to the plan, fill the roles (gateway, Network, Access or Talk controller) it lacks. */
export function RoleFinder({ plan, products, derived, onAdd, onClose }: { plan: DerivedLine[]; products: Product[]; derived: Derived[]; onAdd: (lines: PlanLine[], replacing: PlanLine[]) => void; onClose: () => void }) {
  const found = useMemo(() => {
    const byRef = new Map(products.map((p) => [productRef(p), p]))
    return findRoles(plan, buildCatalog(products, derived), byRef)
  }, [plan, products, derived])
  const extra = found.all.length - found.options.length
  const what = found.missing.map((r) => ROLE_LABEL[r]).join(', ')

  return (
    <Card className="mt-5" aria-label="Find a gateway or controller">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">What would fill {what || 'the gaps'}</h2>
        <button type="button" className="cursor-pointer text-sm text-muted underline underline-offset-2 hover:text-ink" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">Each is added to what's already in the plan. Only whether the application runs is considered, not how many devices it can manage.</p>
      {found.options.length === 0 ? (
        <p className="mt-3 text-sm">Nothing we track fills {what || 'these roles'}{found.missing.length > 1 ? ', alone or as a pair' : ''}, without leaving the plan short of switch ports.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {found.options.map((o) => (
            <RoleRow key={o.label} o={o} label={o.label} onAdd={onAdd} />
          ))}
        </ul>
      )}
      {extra > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-muted">{found.all.length} would work in all</summary>
          <ul className="mt-1 divide-y divide-line">
            {found.all.map((o) => (
              <RoleRow key={o.rows.map((r) => productRef(r.product)).join('+')} o={o} onAdd={onAdd} />
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}
