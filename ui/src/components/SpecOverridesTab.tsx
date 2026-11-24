import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useCan, useDerived, useOverrides } from '../api/queries'
import type { SpecOverride } from '../api/types'
import { regionName } from '../lib/region'
import { AddFact, EntryForm, RemoveOverrideButton } from './OverrideEditor'
import { Badge } from './ui/Badge'
import { Card } from './ui/Card'
import { Select } from './ui/Select'

/** What an override says the value is. */
function overrideText(o: SpecOverride): string {
  if (o.action === 'hide') return '(hidden)'
  if (o.kind === 'flag') return o.value === 'true' ? 'Yes' : o.value === 'false' ? 'No' : o.value
  return o.value
}

/** Where the store files the spec: section, then group when there is one. */
const specName = (o: SpecOverride) => [o.section, o.group, o.label].filter(Boolean).join(' › ')

function OverrideRow({ o, canEdit }: { o: SpecOverride; canEdit: boolean }) {
  const [editing, setEditing] = useState(false)
  return (
    <li className="border-b border-line py-2">
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="min-w-0 text-sm">
          <span className="text-muted sm:hidden">Spec: </span>
          {specName(o)}
        </div>
        <div className="min-w-0 text-sm">
          <span className="text-muted sm:hidden">Official: </span>
          {o.published_now === null ? <span className="text-muted">not published</span> : o.published_now || <span className="text-muted">(empty)</span>}
          {o.stale && (
            <Badge tone="neutral" className="ml-1">
              changed since
            </Badge>
          )}
        </div>
        <div className="min-w-0 text-sm font-medium">
          <span className="font-normal text-muted sm:hidden">Override: </span>
          {overrideText(o)}
          {(o.status === 'orphan' || o.status === 'unknown_product') && (
            <Badge tone="neutral" className="ml-1">
              {o.status === 'orphan' ? 'matches nothing' : 'unknown product'}
            </Badge>
          )}
        </div>
        {canEdit && (
          <div className="flex items-baseline gap-3 text-sm">
            <button type="button" className="cursor-pointer text-accent underline-offset-2 hover:underline" aria-label={`Edit the override of ${o.label}`} onClick={() => setEditing(!editing)}>
              Edit
            </button>
            <RemoveOverrideButton region={o.region} slug={o.slug} id={o.id} label={o.label} className="text-sm" />
          </div>
        )}
      </div>
      {(o.reason || o.note) && (
        <p className="mt-0.5 text-xs text-muted">
          {o.reason}
          {o.reason && o.note ? ' · ' : ''}
          {o.note && `note: ${o.note}`}
        </p>
      )}
      {editing && (
        <EntryForm
          region={o.region}
          slug={o.slug}
          target={{ section: o.section, group: o.group, label: o.label }}
          initial={{ kind: o.kind, value: o.value, note: o.note, source_url: o.source_url, reason: o.reason }}
          published={o.published_now ?? undefined}
          canHide={o.published_now !== null}
          onDone={() => setEditing(false)}
        />
      )}
    </li>
  )
}

/** Picks a product, then offers the form that adds a fact (an override) to it. */
function AddOverride({ products, sections }: { products: { key: string; region: string; slug: string; title: string }[]; sections: Map<string, string[]> }) {
  const [key, setKey] = useState('')
  const chosen = products.find((p) => p.key === key)
  return (
    <div className="mt-4 space-y-3">
      <label className="flex max-w-md flex-col gap-1 text-sm">
        <span className="text-muted">Add an override to</span>
        <Select value={key} onChange={(e) => setKey(e.target.value)} aria-label="Product to add an override to">
          <option value="">Choose a product…</option>
          {products.map((p) => (
            <option key={p.key} value={p.key}>
              {p.title} ({regionName(p.region)})
            </option>
          ))}
        </Select>
      </label>
      {chosen && <AddFact key={chosen.key} region={chosen.region} slug={chosen.slug} sections={sections.get(chosen.key) ?? []} />}
    </div>
  )
}

/**
 * Every override in the database, by product: the spec, what the store publishes, and what the override says. An
 * override of a spec the store publishes corrects it; one the store doesn't publish adds it.
 */
export function SpecOverridesTab() {
  const { data, isPending, isError } = useOverrides()
  const { data: derived } = useDerived()
  const canEdit = useCan('overrides:write')
  const titles = new Map((derived ?? []).map((d) => [`${d.region}/${d.slug}`, d.title]))
  const groups = new Map<string, { key: string; region: string; slug: string; title: string; rows: SpecOverride[] }>()
  for (const o of data ?? []) {
    const key = `${o.region}/${o.slug}`
    const g = groups.get(key) ?? { key, region: o.region, slug: o.slug, title: titles.get(key) ?? o.slug, rows: [] }
    g.rows.push(o)
    groups.set(key, g)
  }
  const list = [...groups.values()].sort((a, b) => a.title.localeCompare(b.title) || a.region.localeCompare(b.region))
  for (const g of list) g.rows.sort((a, b) => specName(a).localeCompare(specName(b)))
  const products = (derived ?? []).map((d) => ({ key: `${d.region}/${d.slug}`, region: d.region, slug: d.slug, title: d.title })).sort((a, b) => a.title.localeCompare(b.title) || a.region.localeCompare(b.region))
  const sections = new Map(list.map((g) => [g.key, [...new Set(g.rows.map((r) => r.section))]]))
  const total = data?.length ?? 0

  return (
    <Card aria-label="Spec overrides">
      <h2 className="font-semibold">Spec overrides</h2>
      {isPending && <p className="mt-1 text-muted">Loading…</p>}
      {isError && <p role="alert" className="mt-1 text-bad">Couldn't load the overrides.</p>}
      {data && (
        <p className="mt-1 text-sm text-muted">
          {total === 0 ? 'No overrides yet.' : `${total} ${total === 1 ? 'override' : 'overrides'} on ${list.length} ${list.length === 1 ? 'product' : 'products'}.`} An override replaces what the store publishes for a spec, hides it, or adds one the store doesn't publish.
        </p>
      )}
      {list.length > 0 && (
        <div className="mt-2 hidden gap-x-4 border-b border-line pb-1 text-sm text-muted sm:grid sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" aria-hidden>
          <span>Spec</span>
          <span>Official value</span>
          <span>Override</span>
          {canEdit && <span className="invisible">Edit Remove</span>}
        </div>
      )}
      {list.map((g) => (
        <section key={g.key} aria-label={`Overrides of ${g.title} (${regionName(g.region)})`} className="mt-3">
          <h3 className="font-medium">
            <Link to="/p/$region/$slug" params={{ region: g.region, slug: g.slug }} className="underline underline-offset-2">
              {g.title}
            </Link>{' '}
            <span className="text-sm font-normal text-muted">{regionName(g.region)}</span>
          </h3>
          <ul>
            {g.rows.map((o) => (
              <OverrideRow key={o.id} o={o} canEdit={canEdit} />
            ))}
          </ul>
        </section>
      ))}
      {canEdit && <AddOverride products={products} sections={sections} />}
    </Card>
  )
}
