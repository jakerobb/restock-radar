import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useDerived, useProducts } from '../api/queries'
import type { Product } from '../api/types'
import { usePlan } from '../hooks/usePlan'
import { formatPrice } from '../lib/format'
import { decodePlan, encodePlan, lineKey, MAX_QTY, planTotals, viewLine, type LineState, type LineView, type PlanLine } from '../lib/plan'
import { planChecks, type CheckVerdict } from '../lib/planChecks'
import { statusInfo } from '../lib/status'
import { PageNav } from './PageNav'
import { RoleFinder } from './RoleFinder'
import { NvrFinder } from './NvrFinder'
import { PlanSearch } from './PlanSearch'
import { SwitchFinder } from './SwitchFinder'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Notice } from './ui/Notice'
import { Select } from './ui/Select'
import { TextInput } from './ui/TextInput'
import type { Tone } from './ui/tone'

const STATE: Record<LineState, { label: string; tone: Tone }> = {
  in: statusInfo('Available'),
  soon: statusInfo('ComingSoon'),
  out: statusInfo('SoldOut'),
  unlisted: { label: 'Variant no longer listed', tone: 'bad' },
  untracked: { label: 'No longer tracked', tone: 'bad' },
}

const VERDICT: Record<CheckVerdict, { mark: string; tone: string }> = {
  ok: { mark: '✓', tone: 'text-ok' },
  bad: { mark: '✕', tone: 'text-bad' },
  warn: { mark: '!', tone: 'text-warn' },
  unknown: { mark: '?', tone: 'text-muted' },
  info: { mark: '•', tone: 'text-muted' },
}

/** A quantity box you can clear and retype in: only a whole number from 1 to 99 changes the plan, and leaving the box shows the real quantity. */
function QtyInput({ qty, label, onChange }: { qty: number; label: string; onChange: (qty: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="number"
      min={1}
      max={MAX_QTY}
      className="w-16 rounded-lg border border-line bg-surface px-2 py-1 text-right text-ink"
      aria-label={label}
      value={draft ?? qty}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value !== '' && Number.isInteger(n) && n >= 1 && n <= MAX_QTY) onChange(n)
      }}
      onBlur={() => setDraft(null)}
    />
  )
}

function LineRow({ view, editable }: { view: LineView; editable: boolean }) {
  const { remove, changeQty, switchVariant } = usePlan()
  const { line, product, variant } = view
  const key = lineKey(line)
  const state = STATE[view.state]
  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className="px-2 py-2">
        {product ? (
          <Link to="/p/$region/$slug" params={{ region: product.region, slug: product.slug }} className="font-medium text-accent underline-offset-2 hover:underline">
            {product.title}
          </Link>
        ) : (
          <span className="font-medium">{line.ref}</span>
        )}
        {product && editable && product.variants.length > 1 ? (
          <Select
            className="mt-1 block max-w-full py-1 text-sm"
            aria-label={`Variant of ${product.title}`}
            value={variant?.sku ?? ''}
            onChange={(e) => {
              const next = product.variants.find((v) => v.sku === e.target.value)
              if (next) switchVariant(key, next)
            }}
          >
            {!variant && <option value="">{line.sku} (no longer listed)</option>}
            {product.variants.map((v) => (
              <option key={v.sku} value={v.sku}>
                {v.title || v.sku}
              </option>
            ))}
          </Select>
        ) : (
          <div className="text-xs text-muted">{variant?.title || line.sku}</div>
        )}
      </td>
      <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
        {view.unitCents === null ? <span className="text-muted">n/a</span> : formatPrice(view.unitCents, view.currency)}
        {view.wasCents !== null && <div className="text-xs text-muted">was {formatPrice(view.wasCents, view.currency)} when added</div>}
      </td>
      <td className="px-2 py-2 text-right">
        {editable ? (
          <QtyInput qty={line.qty} label={`Quantity of ${product?.title ?? line.ref}`} onChange={(n) => changeQty(key, n)} />
        ) : (
          <span className="tabular-nums">{line.qty}</span>
        )}
      </td>
      <td className="px-2 py-2 text-right font-medium tabular-nums whitespace-nowrap">{view.totalCents === null ? <span className="text-muted">n/a</span> : formatPrice(view.totalCents, view.currency)}</td>
      <td className="px-2 py-2 whitespace-nowrap">
        <Badge tone={state.tone}>{state.label}</Badge>
      </td>
      {editable && (
        <td className="px-2 py-2 text-right">
          <button type="button" className="cursor-pointer text-sm text-muted underline underline-offset-2 hover:text-ink" aria-label={`Remove ${product?.title ?? line.ref} from the plan`} onClick={() => remove(key)}>
            Remove
          </button>
        </td>
      )}
    </tr>
  )
}

function ShareLink({ lines, products }: { lines: PlanLine[]; products: Product[] }) {
  const [copied, setCopied] = useState(false)
  const slug = encodePlan(lines, products)
  if (slug === '') return null
  const url = `${window.location.origin}/plan/${slug}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // The link is in the box to copy by hand.
    }
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <TextInput readOnly className="min-w-0 flex-1 py-1 text-sm" value={url} aria-label="Link to this plan" onFocus={(e) => e.currentTarget.select()} />
      <Button variant="secondary" className="px-2 py-1" onClick={() => void copy()} aria-label={copied ? 'Copied' : 'Copy link'} title={copied ? 'Copied' : 'Copy link'}>
        <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {copied ? (
            <path d="M5 13l4 4L19 7" />
          ) : (
            <>
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </>
          )}
        </svg>
      </Button>
    </div>
  )
}

export default function PlanPage() {
  const { slug } = useParams({ strict: false }) as { slug?: string }
  const navigate = useNavigate()
  const mine = usePlan()
  const { data: productData, isPending, isError } = useProducts()
  const { data: derived } = useDerived()
  const [confirmClear, setConfirmClear] = useState(false)

  const shared = slug !== undefined
  // Numbers in a link mean something only next to the catalogue, so a shared plan waits for it.
  const decoded = useMemo(() => (slug === undefined || !productData ? undefined : decodePlan(slug, productData.products)), [slug, productData])
  const lines = useMemo(() => (shared ? (decoded?.lines ?? []) : mine.lines), [shared, decoded, mine.lines])
  const products = useMemo(() => new Map((productData?.products ?? []).map((p) => [`${p.region}/${p.slug}`, p])), [productData?.products])
  const views = useMemo(() => lines.map((l) => viewLine(l, products)), [lines, products])
  const totals = useMemo(() => planTotals(views), [views])
  const derivedLines = useMemo(() => {
    const byRef = new Map((derived ?? []).map((d) => [`${d.region}/${d.slug}`, d]))
    return views.map((view) => ({ view, derived: byRef.get(view.line.ref) ?? null }))
  }, [views, derived])
  const checks = useMemo(() => planChecks(derivedLines), [derivedLines])
  const [finding, setFinding] = useState(false)
  const [findingNvr, setFindingNvr] = useState(false)
  const [findingRoles, setFindingRoles] = useState(false)
  const [searching, setSearching] = useState(false)
  const shortfall = checks.some((c) => c.shortfall)
  const nvrShortfall = checks.some((c) => c.nvrShortfall)
  const missingRoles = checks.flatMap((c) => (c.roleShortfall ? [c.roleShortfall] : []))
  const roleShortfall = missingRoles.length > 0
  const roleLabel = missingRoles.includes('gateway') ? (missingRoles.length > 1 ? 'a gateway or controller' : 'a gateway') : 'a controller'
  const clearControl = confirmClear ? (
    <div className="flex items-center gap-3">
      <span>Remove every line?</span>
      <Button
        variant="secondary"
        className="py-1 text-sm"
        onClick={() => {
          mine.replace([])
          setConfirmClear(false)
        }}
      >
        Yes, clear the plan
      </Button>
      <button type="button" className="cursor-pointer underline underline-offset-2" onClick={() => setConfirmClear(false)}>
        Keep it
      </button>
    </div>
  ) : (
    <button type="button" className="cursor-pointer text-muted underline underline-offset-2 hover:text-ink" onClick={() => setConfirmClear(true)}>
      Clear the plan
    </button>
  )
  const leaveShared = () => void navigate({ to: '/plan', replace: true })

  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-12">
      <PageNav title="Build plan" />
      <p className="mt-1 text-sm text-muted">What you intend to use, with current prices and whether it adds up. Nothing is bought here. The plan is kept in this browser.</p>

      {productData && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          {!shared && (
            <Button variant="secondary" className="py-1 text-sm" onClick={() => setSearching(true)}>
              Add product
            </Button>
          )}
          <ShareLink lines={lines} products={productData.products} />
        </div>
      )}
      {searching && productData && (
        <PlanSearch products={productData.products} inPlan={(ref) => mine.lines.filter((l) => l.ref === ref).reduce((n, l) => n + l.qty, 0)} onAdd={mine.add} onClose={() => setSearching(false)} />
      )}

      {shared && decoded === null && (
        <Notice tone="bad" className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span>That link doesn't hold a plan; it may have been cut short.</span>
          <button type="button" className="cursor-pointer text-sm underline underline-offset-2" onClick={leaveShared}>
            Back to my plan
          </button>
        </Notice>
      )}
      {shared && decoded && (
        <Notice tone="ok" className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span>
            This is a plan someone shared with you, not yours.
            {decoded.unknown > 0 && ` ${decoded.unknown === 1 ? '1 item in it isn’t' : `${decoded.unknown} items in it aren’t`} tracked here, so ${decoded.unknown === 1 ? 'it is' : 'they are'} left out.`}
          </span>
          <Button
            variant="secondary"
            className="py-1 text-sm"
            onClick={() => {
              mine.replace(views.map((v) => ({ ...v.line, addedCents: v.unitCents })))
              leaveShared()
            }}
          >
            {mine.lines.length > 0 ? 'Replace my plan with it' : 'Keep it as my plan'}
          </Button>
          <button type="button" className="cursor-pointer text-sm underline underline-offset-2" onClick={leaveShared}>
            Back to my plan
          </button>
        </Notice>
      )}
      {isPending && <p className="py-8 text-center text-muted">Loading…</p>}
      {isError && <Notice tone="bad" className="mt-4">Couldn't load the catalogue.</Notice>}

      {productData && lines.length === 0 && (
        <p className="py-8 text-muted">
          Nothing in the plan yet. Add products from the{' '}
          <Link to="/find" className="underline">
            finder
          </Link>
          , a product page or a comparison.
        </p>
      )}

      {productData && lines.length > 0 && (
        <>
          <Card className="mt-4 overflow-x-auto" aria-label="Plan">
            <table className="w-full min-w-max border-collapse text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">Product</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Each</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Qty</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Total</th>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">Stock</th>
                  {!shared && <th scope="col" className="px-2 py-1.5"><span className="sr-only">Remove</span></th>}
                </tr>
              </thead>
              <tbody>
                {views.map((v) => (
                  <LineRow key={lineKey(v.line)} view={v} editable={!shared} />
                ))}
              </tbody>
            </table>
            <div className="mt-3 space-y-1 border-t border-line pt-3 text-right" aria-label="Totals">
              {totals.sums.map((s) => (
                <div key={s.currency} className="text-lg font-semibold tabular-nums">
                  Total {formatPrice(s.cents, s.currency)}
                </div>
              ))}
              {totals.unpriced > 0 && <div className="text-sm text-muted">{totals.unpriced === 1 ? '1 line has' : `${totals.unpriced} lines have`} no price and isn't counted.</div>}
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
                {shared ? <span /> : clearControl}
                {totals.notInStock.length === 0 ? (
                  <span className="text-ok">Everything is in stock.</span>
                ) : (
                  <span className="text-bad">Not in stock: {totals.notInStock.map((v) => v.product?.title ?? v.line.ref).join(', ')}.</span>
                )}
              </div>
            </div>
          </Card>

          {checks.length > 0 && (
            <Card className="mt-5" aria-label="Checks">
              <h2 className="mb-1 text-lg font-semibold">Does it add up?</h2>
              <ul className="divide-y divide-line text-sm">
                {checks.map((c) => (
                  <li key={c.id} className="flex gap-2 py-1.5">
                    <span aria-hidden className={`w-4 shrink-0 text-center font-bold ${VERDICT[c.verdict].tone}`}>
                      {VERDICT[c.verdict].mark}
                    </span>
                    <span>
                      <span className="font-medium">{c.label}: </span>
                      {c.detail ? (
                        <details className="inline-block align-top">
                          <summary className="cursor-pointer">{c.text}</summary>
                          <div className="mt-1 space-y-2 text-muted">
                            {c.detail.map((b) => (
                              <div key={b.title}>
                                <div className="font-medium text-ink">{b.title}</div>
                                <ul className="list-disc pl-5">
                                  {b.rows.map((r) => (
                                    <li key={r}>{r}</li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : (
                        c.text
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Based on published specifications and any corrections/additions. Unknown status are labeled as such, not guessed.</p>
              {!shared && ((shortfall && !finding) || (nvrShortfall && !findingNvr) || (roleShortfall && !findingRoles)) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {shortfall && !finding && (
                    <Button variant="secondary" className="py-1 text-sm" onClick={() => setFinding(true)}>
                      Find a switch
                    </Button>
                  )}
                  {nvrShortfall && !findingNvr && (
                    <Button variant="secondary" className="py-1 text-sm" onClick={() => setFindingNvr(true)}>
                      Find an NVR
                    </Button>
                  )}
                  {roleShortfall && !findingRoles && (
                    <Button variant="secondary" className="py-1 text-sm" onClick={() => setFindingRoles(true)}>
                      Find {roleLabel}
                    </Button>
                  )}
                </div>
              )}
            </Card>
          )}
          {shortfall && !shared && finding && <SwitchFinder plan={derivedLines} products={productData?.products ?? []} derived={derived ?? []} onAdd={(added, replacing) => {
            for (const r of replacing) mine.remove(lineKey(r))
            for (const l of added) mine.add(l)
          }} onClose={() => setFinding(false)} />}
          {roleShortfall && !shared && findingRoles && <RoleFinder plan={derivedLines} products={productData?.products ?? []} derived={derived ?? []} onAdd={(added, replacing) => {
            for (const r of replacing) mine.remove(lineKey(r))
            for (const l of added) mine.add(l)
          }} onClose={() => setFindingRoles(false)} />}
          {nvrShortfall && !shared && findingNvr && <NvrFinder plan={derivedLines} products={productData?.products ?? []} derived={derived ?? []} onAdd={(l, replacing) => {
            for (const r of replacing) mine.remove(lineKey(r))
            mine.add(l)
          }} onClose={() => setFindingNvr(false)} />}
        </>
      )}
    </main>
  )
}
