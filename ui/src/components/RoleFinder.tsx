import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import type { Derived, Product } from '../api/types'
import { buildCatalog } from '../lib/catalog'
import { productRef } from '../lib/compare'
import { formatPrice } from '../lib/format'
import { lineFor, type PlanLine } from '../lib/plan'
import type { DerivedLine } from '../lib/planChecks'
import { findRoles, type ListedRole } from '../lib/roleFinder'
import type { Hosting } from '../lib/roles'
import { APP_NAME, appsRun, gatewayLabel, hostedNote, isGatewayProduct, managedOf, ROLE_LABEL, type HostedRole } from '../lib/roles'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Card } from './ui/Card'

const APP_LABEL: Record<string, string> = { network: 'Network', protect: 'Protect', access: 'Access', talk: 'Talk' }

/** What a product does, one thing after another: "5 Gbps gateway, Network controller (50+ devices), Protect controller". */
function roles(r: ListedRole['rows'][number], withName: boolean): string {
  const count = (name: string, noun: string) => {
    const m = managedOf(r.product, r.derived, name)
    return m ? ` (${m.value.toLocaleString('en-US')}${m.plus ? '+' : ''} ${noun})` : ''
  }
  const parts = [isGatewayProduct(r.product, r.derived) ? gatewayLabel(r.derived) : null, ...appsRun(r.product, r.derived).map((a) => `${APP_LABEL[a]} controller${a === 'network' ? count('managed_devices', 'devices') : a === 'access' ? count('managed_access_hubs', 'hubs') : ''}`)]
  const what = parts.filter(Boolean).join(', ') || 'no applications listed'
  // The name is already in the line above; it is only repeated to say which of two products does what.
  return withName ? `${r.product.title}: ${what}` : what
}

function RoleRow({ o, label, onAdd }: { o: ListedRole; label?: string; onAdd: (lines: PlanLine[], replacing: PlanLine[]) => void }) {
  const title = o.rows.map((r) => r.product.title).join(' and ')
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-56 text-sm">
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
          {o.rows.map((r) => roles(r, o.rows.length > 1)).join(' · ')}
        </div>
        {o.rows.map((r) => hostedNote(r.product)).filter(Boolean).map((n) => (
          <div key={n} className="mt-0.5 text-muted">
            {n}
          </div>
        ))}
        {o.unverified && <div className="mt-0.5 text-muted">The store doesn't say how many devices it manages, so it can't be shown to manage the plan's.</div>}
        {o.replaces.length > 0 && (
          <div className="mt-0.5 text-muted">
            Replaces {o.replaces.map((l) => l.view.product?.title ?? l.view.line.ref).join(', ')}, which {o.replaces.every((l) => o.undersized.includes(l)) ? 'manages too few devices for the plan' : o.replaces.some((l) => o.undersized.includes(l)) ? "can't be bought now or manages too few devices for the plan" : "can't be bought now"}.
          </div>
        )}
      </div>
      <Button
        variant="secondary"
        className="shrink-0 py-1 text-sm"
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
export function RoleFinder({ plan, products, derived, hosting, onAdd, onHost, onClose }: { plan: DerivedLine[]; products: Product[]; derived: Derived[]; hosting: Hosting; onAdd: (lines: PlanLine[], replacing: PlanLine[]) => void; onHost: (role: HostedRole) => void; onClose: () => void }) {
  const found = useMemo(() => {
    const byRef = new Map(products.map((p) => [productRef(p), p]))
    return findRoles(plan, buildCatalog(products, derived), byRef, hosting)
  }, [plan, products, derived, hosting])
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
      <p className="mt-1 text-sm text-muted">Each is added to what's already in the plan.</p>
      {found.hostable.length > 0 && (
        <div className="mt-3 text-sm">
          <div className="text-xs font-medium tracking-wide text-muted uppercase">Or self-host it</div>
          <p className="mt-0.5 text-muted">You run the controller on a machine of your own. It isn't something you buy, but it goes in the plan as an entry, so the checks count it and a shared link keeps it. How many devices it manages isn't checked.</p>
          <ul className="mt-1 divide-y divide-line">
            {found.hostable.map((role) => (
              <li key={role} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
                <span>{ROLE_LABEL[role]}</span>
                <Button variant="secondary" className="py-1 text-sm" aria-label={`Self-host ${APP_NAME[role]}`} onClick={() => onHost(role)}>
                  Self-host
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
