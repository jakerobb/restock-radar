import { Link, useParams } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useHistory, useProductSpecs, useProducts } from '../api/queries'
import type { Derived, Port, Product, SpecEntry } from '../api/types'
import { indexHistory } from '../lib/history'
import { formatSpeed, metricInfo } from '../lib/requirements'
import { useHistoryDays } from '../hooks/useHistoryDays'
import { ProductCard } from './ProductCard'
import { PageNav } from './PageNav'
import { HistoryRangePicker } from './HistoryRangePicker'
import { Badge } from './ui/Badge'
import { Card } from './ui/Card'
import { Notice } from './ui/Notice'

const ORIGIN_LABEL: Record<string, string> = { override: 'Overridden', added: 'Added' }

function portText(p: Port): string {
  const poe = p.poe_class ? ` · ${p.poe_class}${p.poe_direction ? ` ${p.poe_direction}` : ''}${p.poe_inferred ? ' (inferred)' : ''}${p.poe_watts ? `, ${p.poe_watts} W` : ''}` : ''
  const speeds = p.speeds_mbps.length > 1 ? ` (${p.speeds_mbps.map(formatSpeed).join(' / ')})` : ''
  return `${p.count} × ${p.label}${speeds}${poe}`
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

const Unknown = () => <span className="text-muted">not stated</span>

function DerivedSummary({ d }: { d: Derived }) {
  const flagged = (changed: boolean) => (changed ? <Badge tone="warn" className="ml-2">overridden</Badge> : null)
  return (
    <Card aria-label="At a glance">
      <h2 className="mb-1 text-lg font-semibold">At a glance</h2>
      <dl className="divide-y divide-line">
        <Fact label="Ports">
          {d.known.ports ? (
            d.ports.length > 0 ? (
              <ul>
                {d.ports.map((p, i) => (
                  <li key={i}>{portText(p)}</li>
                ))}
              </ul>
            ) : (
              'none'
            )
          ) : (
            <Unknown />
          )}
          {flagged(d.overridden.ports)}
        </Fact>
        {d.poe_budget.length > 0 && (
          <Fact label="PoE budget">
            <ul>
              {d.poe_budget.map((s, i) => (
                <li key={i} className={s.selected ? 'font-medium' : 'text-muted'}>
                  {s.watts} W{s.name ? ` — ${s.name}` : ''}
                  {s.selected && d.poe_budget.length > 1 && ' (used for sorting)'}
                </li>
              ))}
            </ul>
            {flagged(d.overridden.poe_budget)}
          </Fact>
        )}
        {d.radios.length > 0 && (
          <Fact label="Radios">
            <ul>
              {d.radios.map((r, i) => (
                <li key={i}>
                  {r.band}
                  {[r.streams !== null && `${r.streams} streams`, r.tx_power_dbm !== null && `${r.tx_power_dbm} dBm TX`, r.antenna_gain_dbi !== null && `${r.antenna_gain_dbi} dBi`].filter(Boolean).map((t) => ` · ${t}`)}
                </li>
              ))}
            </ul>
            {flagged(d.overridden.radios)}
          </Fact>
        )}
        <Fact label="Rack">
          {d.known.rack ? d.rack.mountable ? `Rack-mount${d.rack.units ? `, ${d.rack.units}U` : ''}` : 'Not rack-mount' : <Unknown />}
          {flagged(d.overridden.rack)}
        </Fact>
        <Fact label="Dimensions">
          {d.known.dims && d.dims.max_mm > 0 ? `${d.dims.min_mm} × ${d.dims.mid_mm} × ${d.dims.max_mm} mm` : <Unknown />}
          {flagged(d.overridden.dims)}
        </Fact>
        {d.metrics.length > 0 && (
          <Fact label="Numbers">
            <ul>
              {d.metrics.map((m) => {
                const over = d.overridden.metrics.find((o) => o.name === m.name)
                return (
                  <li key={m.name}>
                    {metricInfo(m.name)?.label ?? m.name}: {m.at_least ? '≥ ' : ''}
                    {m.value}
                    {m.unit ? ` ${m.unit}` : ''}
                    {over && (
                      <Badge tone="warn" className="ml-2">
                        overridden{over.published ? `, published ${over.published.value}${over.published.unit ? ` ${over.published.unit}` : ''}` : ', not published'}
                      </Badge>
                    )}
                  </li>
                )
              })}
            </ul>
          </Fact>
        )}
      </dl>
    </Card>
  )
}

/** The effective specification, grouped by section, with overrides shown beside what the store published. */
function SpecTable({ specs }: { specs: SpecEntry[] }) {
  const sections = useMemo(() => {
    const out = new Map<string, SpecEntry[]>()
    // The grid overview repeats entries of the other sections.
    for (const s of specs.filter((e) => e.section_type !== 'Overview')) out.set(s.section, [...(out.get(s.section) ?? []), s])
    return [...out]
  }, [specs])
  if (sections.length === 0) return <p className="text-muted">No specification has been collected for this product yet.</p>
  return (
    <div className="space-y-4">
      {sections.map(([section, entries]) => (
        <Card key={section} aria-label={section}>
          <h3 className="mb-1 font-semibold">{section}</h3>
          <dl className="divide-y divide-line text-sm">
            {entries.map((e, i) =>
              e.kind === 'group' ? (
                <dt key={i} className="pt-2 pb-1 font-medium">
                  {e.label}
                </dt>
              ) : (
                <div key={i} className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 py-1.5 ${e.parent_id ? 'pl-4' : ''}`}>
                  <dt className="text-muted">{e.label}</dt>
                  <dd className="whitespace-pre-line">
                    {e.kind === 'flag' ? (e.value === 'true' ? 'Yes' : 'No') : e.value}
                    {ORIGIN_LABEL[e.origin] && (
                      <Badge tone="warn" className="ml-2">
                        {ORIGIN_LABEL[e.origin]}
                        {e.stale ? ', published value changed' : ''}
                      </Badge>
                    )}
                    {e.published_value !== undefined && <span className="mt-0.5 block text-xs text-muted">Published: {e.published_value}</span>}
                    {e.note && <span className="mt-0.5 block text-xs text-muted">{e.note}</span>}
                  </dd>
                </div>
              ),
            )}
          </dl>
        </Card>
      ))}
    </div>
  )
}

export default function ProductPage() {
  const { region, slug } = useParams({ strict: false }) as { region: string; slug: string }
  const { data: productData, isPending } = useProducts()
  const specs = useProductSpecs(region, slug)
  const [days, setDays] = useHistoryDays()
  const history = useHistory(days)

  const product: Product | undefined = productData?.products.find((p) => p.region === region && p.slug === slug)
  const index = useMemo(() => (history.data ? indexHistory(history.data) : undefined), [history.data])

  if (isPending || (specs.isPending && !product)) {
    return (
      <main className="mx-auto max-w-4xl px-4 pt-6 pb-12">
        <PageNav title="Product" />
        <p className="py-8 text-center text-muted">Loading…</p>
      </main>
    )
  }
  if (!product && specs.isError) {
    return (
      <main className="mx-auto max-w-4xl px-4 pt-6 pb-12">
        <PageNav title="Product" />
        <Notice tone="bad" className="mt-4">
          We aren't tracking a product called <code>{region}/{slug}</code>. <Link to="/find" className="underline">Find one</Link>
        </Notice>
      </main>
    )
  }

  const title = product?.title ?? specs.data?.title ?? slug
  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-12">
      <PageNav title={title} />
      <div className="mt-4 space-y-5">
        {product && (
          <div>
            <div className="mb-2 flex justify-end">
              <HistoryRangePicker days={days} onChange={setDays} />
            </div>
            <ProductCard product={product} showRegion={(productData?.regions.length ?? 0) > 1} history={index} />
          </div>
        )}
        {specs.data?.derived && <DerivedSummary d={specs.data.derived} />}
        {specs.data && specs.data.overrides.length > 0 && (
          <Card aria-label="Overrides">
            <h2 className="mb-1 text-lg font-semibold">Corrections to the published specification</h2>
            <ul className="space-y-2 text-sm">
              {specs.data.overrides.map((o) => (
                <li key={o.id}>
                  <strong>{o.label}</strong>: {o.action === 'hide' ? 'hidden' : o.value}
                  {o.stale && <Badge tone="warn" className="ml-2">published value changed</Badge>}
                  {(o.reason || o.source_url) && (
                    <span className="block text-muted">
                      {o.reason}
                      {o.source_url && (
                        <>
                          {' '}
                          <a href={o.source_url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                            source
                          </a>
                        </>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
        <section aria-label="Specification">
          <h2 className="mb-2 text-lg font-semibold">Specification</h2>
          {specs.isError ? <Notice tone="bad">Couldn't load the specification.</Notice> : <SpecTable specs={specs.data?.specs ?? []} />}
        </section>
      </div>
    </main>
  )
}
