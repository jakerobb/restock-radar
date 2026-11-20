import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useMemo, useState, type ReactNode } from 'react'
import { useDerived, useProducts } from '../api/queries'
import type { Derived, Product } from '../api/types'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { usePlan } from '../hooks/usePlan'
import { useRegion } from '../hooks/useRegion'
import { inRegion } from '../lib/region'
import { productRef } from '../lib/compare'
import { DRIVE_SIZES_TB, driveBays, driveOf } from '../lib/nvrStorage'
import { formatPrice, totalCents } from '../lib/format'
import { decodePlan, DEFAULT_PLAN_NAME, defaultVariant, encodePlan, lineKey, MAX_QTY, planTotals, viewLine, type LineState, type LineView, type PlanLine } from '../lib/plan'
import { budgetOf, includedScenario, powerOptions, withSiblings, type PowerOption, type Powering } from '../lib/powering'
import { buildTopology } from '../lib/topology'
import { overall, planChecks, type CheckVerdict, type DerivedLine } from '../lib/planChecks'
import { APP_NAME, HOSTED_ROLES, type HostedRole, type Hosting } from '../lib/roles'
import { statusInfo } from '../lib/status'
import { MAX_PLANS, nameTaken, uniqueName } from '../lib/planStore'
import { Dialog } from './Dialog'
import { PageNav } from './PageNav'
import { TopologyGraph } from './TopologyGraph'
import { RoleFinder } from './RoleFinder'
import { NvrFinder } from './NvrFinder'
import { PlanSearch } from './PlanSearch'
import { ConvertPlan } from './ConvertPlan'
import { NamePlanDialog } from './NamePlanDialog'
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

const VERDICT_TONE = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' } as const

const VERDICT: Record<CheckVerdict, { mark: string; tone: string }> = {
  ok: { mark: '✓', tone: 'text-ok' },
  bad: { mark: '✕', tone: 'text-bad' },
  warn: { mark: '!', tone: 'text-warn' },
  unknown: { mark: '?', tone: 'text-muted' },
  info: { mark: '•', tone: 'text-muted' },
}

/** A quantity box you can clear and retype in: only a whole number from 1 to 99 changes the plan, and leaving the box shows the real quantity. */
/** A numbered list when the order is the point (what goes in the rack, top to bottom), else bullets. */
function ListTag({ ordered, children }: { ordered?: boolean; children: React.ReactNode }) {
  return ordered ? <ol className="list-decimal pl-5 text-muted">{children}</ol> : <ul className="list-disc pl-5 text-muted">{children}</ul>
}

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

/** How a line's switch can be powered, when that is a choice, and what has been chosen. */
interface PowerChoice {
  options: PowerOption[]
  /** The option in effect: chosen, or the one in the box; null when nothing has been chosen. */
  chosen: PowerOption | null
  /** The name of the scenario that comes with the product. */
  included: string | null
  adapterProduct: (slug: string) => Product | null
  /** A product of the range, by slug, for an option that is a matter of which product it is. */
  sibling: (slug: string) => Product | null
}

/** The drive bays of an NVR line, and the drives the plan can fill them with. */
interface DriveChoice {
  bays: number
  /** Drives by size, smallest first. */
  options: { product: Product; tb: number }[]
}

function LineRow({ view, editable, linked, power, drives }: { view: LineView; editable: boolean; linked: { product: Product; label?: string }[]; power: PowerChoice | null; drives: DriveChoice | null }) {
  const { lines, remove, changeQty, switchVariant, addOn, swapProduct, power: choosePower } = usePlan()
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
            className="mt-1 block max-w-64 py-1 text-sm"
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
        {product && editable && power && (
          <Select
            className="mt-1 block max-w-64 py-1 text-sm"
            aria-label={`Power for ${product.title}`}
            value={power.chosen?.code ?? ''}
            onChange={(e) => {
              const o = power.options.find((x) => x.code === Number(e.target.value))
              const to = o?.swapSlug ? power.sibling(o.swapSlug) : null
              if (o && to) swapProduct(key, to, line.qty)
              else if (o) choosePower(key, o.code, o.adapter ? power.adapterProduct(o.adapter.slug) : null, line.qty)
            }}
          >
            {!power.chosen && (
              <option value="" disabled>
                Choose how it is powered
              </option>
            )}
            {power.options.map((o) => (
              <option key={o.code} value={o.code}>
                {o.poeInputs && o.poeInputs.length > 1
                  ? `PoE: ${o.poeInputs[0]!.watts}–${o.scenario.watts} W, by the port it is on`
                  : `${o.scenario.name.replace(/ input$/i, '')}: ${o.scenario.watts} W`}
                {o.scenario.name === power.included && ' (included)'}
                {o.adapter && ' (adapter added)'}
                {o.swapSlug && ` (as ${power.sibling(o.swapSlug)?.title ?? o.swapSlug})`}
              </option>
            ))}
          </Select>
        )}
        {product && editable && drives && (() => {
          const all = drives.options.map((o) => o.product)
          const inPlan = drives.options.filter((o) => lines.some((x) => x.ref === productRef(o.product)))
          const chosen = inPlan[0] ?? null
          const total = chosen ? (lines.find((x) => x.ref === productRef(chosen.product))?.qty ?? 0) : 0
          const count = Math.min(drives.bays, Math.max(1, Math.ceil(total / line.qty)))
          const set = (p: Product | null, n: number) => addOn(all, p, n * line.qty)
          return (
            <div className="mt-1 flex max-w-64 items-center gap-1">
              <Select
                className="block min-w-0 flex-1 py-1 text-sm"
                aria-label={`Drives for ${product.title}`}
                value={chosen?.product.slug ?? ''}
                onChange={(e) => set(drives.options.find((o) => o.product.slug === e.target.value)?.product ?? null, chosen ? count : drives.bays)}
              >
                <option value="">No drives</option>
                {drives.options.map(({ product: p, tb }) => {
                  const v = defaultVariant(p)
                  const cents = v ? totalCents(v) : null
                  return (
                    <option key={p.slug} value={p.slug}>
                      {tb} TB drives
                      {cents !== null && ` (+${formatPrice(cents, v!.currency)} each)`}
                      {v && v.status !== 'Available' && ` — ${statusInfo(v.status).label.toLowerCase()}`}
                    </option>
                  )
                })}
              </Select>
              {chosen && (
                <>
                  <span className="text-sm text-muted">×</span>
                  <Select className="block w-16 py-1 text-sm" aria-label={`Number of drives for ${product.title}`} value={count} onChange={(e) => set(chosen.product, Number(e.target.value))}>
                    {Array.from({ length: drives.bays }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </>
              )}
            </div>
          )
        })()}
        {product && editable && linked.length > 0 && (
          <Select
            className="mt-1 block max-w-64 py-1 text-sm"
            aria-label={`Sold with ${product.title}`}
            value={linked.find((l) => lines.some((x) => x.ref === productRef(l.product)))?.product.slug ?? ''}
            onChange={(e) =>
              addOn(
                linked.map((l) => l.product),
                linked.find((l) => l.product.slug === e.target.value)?.product ?? null,
                line.qty,
              )
            }
          >
            <option value="">{product.linked_none ?? 'Nothing sold with it'}</option>
            {[...linked].sort((a, b) => (a.label ?? a.product.title).localeCompare(b.label ?? b.product.title)).map(({ product: p, label }) => {
              const v = defaultVariant(p)
              const cents = v ? totalCents(v) : null
              return (
                <option key={p.slug} value={p.slug}>
                  {label ?? p.title}
                  {cents !== null && ` (+${formatPrice(cents, v!.currency)})`}
                  {v && v.status !== 'Available' && ` — ${statusInfo(v.status).label.toLowerCase()}`}
                </option>
              )
            })}
          </Select>
        )}
      </td>
      <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
        {view.unitCents === null ? <span className="text-muted">n/a</span> : formatPrice(view.unitCents, view.currency)}
        {view.wasCents !== null && <div className="ml-auto max-w-24 text-xs whitespace-normal text-muted">was {formatPrice(view.wasCents, view.currency)} when added</div>}
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

/** A controller the owner runs themselves: an entry in the plan, though not something to buy. */
function HostedRow({ role, editable }: { role: HostedRole; editable: boolean }) {
  const { host } = usePlan()
  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className="px-2 py-2">
        <span className="font-medium">Self-hosted {APP_NAME[role]}</span>
        <div className="text-xs text-muted">You run it yourself; not a product</div>
      </td>
      <td className="px-2 py-2 text-right text-muted">—</td>
      <td className="px-2 py-2 text-right text-muted">—</td>
      <td className="px-2 py-2 text-right text-muted">—</td>
      <td className="px-2 py-2 text-muted">—</td>
      {editable && (
        <td className="px-2 py-2 text-right">
          <button type="button" className="cursor-pointer text-sm text-muted underline underline-offset-2 hover:text-ink" aria-label={`Remove self-hosted ${APP_NAME[role]} from the plan`} onClick={() => host(role, null)}>
            Remove
          </button>
        </td>
      )}
    </tr>
  )
}

/** The drives an NVR with bays can be given: the hard drives of the sizes on offer that the store sells in its region. */
function driveChoiceOf(d: Derived | null, product: Product | undefined, products: Map<string, Product>): DriveChoice | null {
  const bays = driveBays(d)
  if (!product || bays === 0) return null
  const options = [...products.values()].flatMap((p) => {
    const sku = defaultVariant(p)?.sku ?? ''
    const drive = p.region === product.region && /^UACC-HDD-/i.test(sku) ? driveOf(sku) : null
    return drive && DRIVE_SIZES_TB.includes(drive.tb) ? [{ product: p, tb: drive.tb }] : []
  })
  return options.length === 0 ? null : { bays, options: options.sort((a, b) => a.tb - b.tb) }
}

function powerChoiceOf(l: DerivedLine, powering: Powering, products: Map<string, Product>, allDerived: Derived[]): PowerChoice | null {
  const base = powerOptions(l.derived)
  const product = l.view.product
  if (!base || !l.derived || !product) return null
  // The other products of its range (a Switch Ultra with its own adapter) are other ways to power it.
  const siblings = product.collection === '' ? [] : allDerived.filter((d) => d.slug !== product.slug && d.region === product.region && products.get(`${d.region}/${d.slug}`)?.collection === product.collection)
  const options = withSiblings(base, l.derived, siblings.map((d) => ({ slug: d.slug, derived: d })))
  return {
    options,
    chosen: options.find((o) => o.code === budgetOf(l, powering).option?.code) ?? null,
    included: includedScenario(l.derived)?.name ?? null,
    adapterProduct: (slug) => products.get(`${product.region}/${slug}`) ?? null,
    sibling: (slug) => products.get(`${product.region}/${slug}`) ?? null,
  }
}

function ShareLink({ name, lines, products, hosting, powering }: { name: string; lines: PlanLine[]; products: Product[]; hosting: Hosting; powering: Powering }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const slug = encodePlan(lines, products, hosting, powering, name)
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
  const icon = (children: ReactNode) => (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end">
      <Button variant="secondary" className="px-2 py-1" onClick={() => setOpen(true)} aria-label="Share this plan" title="Share this plan">
        {icon(
          <>
            <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
            <path d="M16 6l-4-4-4 4" />
            <path d="M12 2v13" />
          </>,
        )}
      </Button>
      {open && (
        <Dialog
          title="Share this plan"
          onClose={() => {
            setOpen(false)
            setCopied(false)
          }}
        >
          <div className="flex items-center gap-2">
            <TextInput readOnly className="min-w-0 flex-1 py-1 text-sm" value={url} aria-label="Link to this plan" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="secondary" className="px-2 py-1" onClick={() => void copy()} aria-label={copied ? 'Copied' : 'Copy link'} title={copied ? 'Copied' : 'Copy link'}>
              {icon(
                copied ? (
                  <path d="M5 13l4 4L19 7" />
                ) : (
                  <>
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </>
                ),
              )}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

/** Which plan is being edited, and the ways to start, rename and delete them. */
function PlanSwitcher() {
  const { plans, activeId, name, select, create, rename, destroy } = usePlan()
  const [dialog, setDialog] = useState<'new' | 'rename' | 'delete' | null>(null)
  // Alphabetical in the list (with numbers in order: Plan 2 before Plan 10); the plans keep the order they were made in.
  const byName = useMemo(() => [...plans].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })), [plans])
  const close = () => setDialog(null)
  const small = 'cursor-pointer text-sm text-muted underline underline-offset-2 hover:text-ink'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Select className="min-w-0 max-w-full py-1 text-sm font-medium" value={activeId} onChange={(e) => select(e.target.value)} aria-label="Which plan">
        {byName.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <button type="button" className={small} onClick={() => setDialog('rename')}>
        Rename
      </button>
      <button type="button" className={small} onClick={() => setDialog('new')} disabled={plans.length >= MAX_PLANS}>
        New plan
      </button>
      <button type="button" className={small} onClick={() => setDialog('delete')}>
        Delete
      </button>
      {dialog === 'rename' && (
        <NamePlanDialog
          title="Rename this plan"
          label="Name"
          initial={name}
          submit="Rename"
          taken={(n) => nameTaken(plans, n, activeId)}
          onSubmit={(n) => {
            rename(n)
            close()
          }}
          onClose={close}
        />
      )}
      {dialog === 'new' && (
        <NamePlanDialog
          title="New plan"
          label="Name"
          initial={uniqueName(plans, `Plan ${plans.length + 1}`)}
          submit="Create"
          taken={(n) => nameTaken(plans, n)}
          onSubmit={(n) => {
            create(n)
            close()
          }}
          onClose={close}
        />
      )}
      {dialog === 'delete' && (
        <Dialog title="Delete this plan?" onClose={close}>
          <p className="mb-4 text-sm">
            “{name}” will be gone for good{plans.length === 1 ? ' (you always have a plan, so it will be emptied and named “' + DEFAULT_PLAN_NAME + '” again)' : ''}.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Keep it
            </Button>
            <Button
              data-autofocus
              onClick={() => {
                destroy()
                close()
              }}
            >
              Delete
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

export default function PlanPage() {
  const { slug } = useParams({ strict: false }) as { slug?: string }
  const navigate = useNavigate()
  const mine = usePlan()
  const { data: productData, isPending, isError } = useProducts()
  const { data: derived } = useDerived()
  const { region } = useRegion()
  // What can be added is what the chosen store sells; the plan itself may hold lines from any.
  const offered = useMemo(() => inRegion(productData?.products ?? [], region), [productData?.products, region])
  const [confirmClear, setConfirmClear] = useState(false)
  const [saving, setSaving] = useState(false)

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
  const hosting: Hosting = useMemo(() => (shared ? (decoded?.hosting ?? {}) : mine.hosting), [shared, decoded, mine.hosting])
  const powering = useMemo(() => (shared ? (decoded?.powering ?? {}) : mine.powering), [shared, decoded, mine.powering])
  const checks = useMemo(() => planChecks(derivedLines, hosting, powering), [derivedLines, hosting, powering])
  const answer = useMemo(() => overall(checks), [checks])
  const topology = useMemo(() => buildTopology(derivedLines, hosting, powering), [derivedLines, hosting, powering])
  const wide = useMediaQuery('(min-width: 80rem)') // Tailwind's xl: two columns under a full-width topology, which is open
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
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-12 xl:max-w-[88rem]">
      <PageNav title="Build plan" />
      <p className="mt-1 text-sm text-muted">What you intend to use, with current prices and whether it adds up. Nothing is bought here. Your plans are kept in this browser.</p>
      {!shared && (
        <div className="mt-3">
          <PlanSwitcher />
        </div>
      )}

      {productData && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          {!shared && (
            <Button variant="secondary" className="py-1 text-sm" onClick={() => setSearching(true)}>
              Add product
            </Button>
          )}
          <ConvertPlan
            name={shared ? (decoded?.name ?? DEFAULT_PLAN_NAME) : mine.name}
            lines={lines}
            hosting={hosting}
            powering={powering}
            products={productData.products}
            regions={productData.regions}
            suggested={lines.some((l) => !l.ref.startsWith(`${region}/`)) ? region : (productData.regions.find((r) => r !== region) ?? region)}
          />
          <ShareLink name={shared ? (decoded?.name ?? DEFAULT_PLAN_NAME) : mine.name} lines={lines} products={productData.products} hosting={hosting} powering={powering} />
        </div>
      )}
      {searching && productData && (
        <PlanSearch products={offered} inPlan={(ref) => mine.lines.filter((l) => l.ref === ref).reduce((n, l) => n + l.qty, 0)} onAdd={mine.add} onClose={() => setSearching(false)} />
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
            This is a plan someone shared with you: <strong>{decoded.name}</strong>. It isn’t one of yours.
            {decoded.unknown > 0 && ` ${decoded.unknown === 1 ? '1 item in it isn’t' : `${decoded.unknown} items in it aren’t`} tracked here, so ${decoded.unknown === 1 ? 'it is' : 'they are'} left out.`}
          </span>
          <Button variant="secondary" className="py-1 text-sm" onClick={() => setSaving(true)} disabled={mine.plans.length >= MAX_PLANS}>
            Save as a new plan
          </Button>
          <button type="button" className="cursor-pointer text-sm underline underline-offset-2" onClick={leaveShared}>
            Back to my plan
          </button>
        </Notice>
      )}
      {saving && decoded && (
        <NamePlanDialog
          title="Save as a new plan"
          label="Name for your copy"
          initial={uniqueName(mine.plans, decoded.name)}
          submit="Save"
          taken={(n) => nameTaken(mine.plans, n)}
          onSubmit={(n) => {
            mine.create(n, views.map((v) => ({ ...v.line, addedCents: v.unitCents })), decoded.hosting, decoded.powering)
            setSaving(false)
            leaveShared()
          }}
          onClose={() => setSaving(false)}
        />
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
        // Stacked when narrow; wide, the plan and what it needs go on the left and the checks on the right.
        (() => {
          const planCard = (
          <Card className="mt-4 overflow-x-auto" aria-label="Plan">
            <table className="w-full border-collapse text-sm">
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
                {derivedLines.map(({ view: v, derived: d }) => (
                  <LineRow key={lineKey(v.line)} view={v} editable={!shared} drives={driveChoiceOf(d, v.product, products)} power={powerChoiceOf({ view: v, derived: d }, powering, products, derived ?? [])} linked={(v.product?.linked ?? []).flatMap((l) => {
                    const p = products.get(`${v.product!.region}/${l.slug}`)
                    return p ? [{ product: p, label: l.label }] : []
                  })} />
                ))}
                {HOSTED_ROLES.filter((r) => hosting[r]).map((role) => (
                  <HostedRow key={role} role={role} editable={!shared} />
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
          )
          const checksCard = checks.length > 0 && (
            <Card className="mt-4" aria-label="Checks">
              <h2 className="text-lg font-semibold">Does it add up?</h2>
              {answer && (
                <p className={`mt-1 mb-2 text-4xl font-bold ${VERDICT_TONE[answer.tone]}`} aria-label={`Answer: ${answer.word}`}>
                  {answer.word} <span aria-hidden>{answer.emoji}</span>
                </p>
              )}
              <ul className="divide-y divide-line text-sm">
                {checks.map((c) => (
                  <li key={c.id} className="flex gap-2 py-1.5">
                    <span aria-hidden className={`w-4 shrink-0 text-center font-bold ${VERDICT[c.verdict].tone}`}>
                      {VERDICT[c.verdict].mark}
                    </span>
                    <div className="min-w-0 flex-1">
                      {c.detail ? (
                        <details>
                          <summary className="cursor-pointer">
                            <span className="font-medium">{c.label}: </span>
                            {c.text}
                          </summary>
                          <div className="mt-1 space-y-2 pl-5 text-muted">
                            {c.detail.map((blk) => (
                              <div key={blk.title}>
                                <div className="font-medium text-ink">{blk.title}</div>
                                <ul className="list-disc pl-5">
                                  {blk.rows.map((r) => (
                                    <li key={typeof r === 'string' ? r : r.text}>
                                      {typeof r === 'string' ? r : r.text}
                                      {typeof r !== 'string' && (
                                        <ul className="list-disc pl-5">
                                          {r.items.map((i) => (
                                            <li key={i}>{i}</li>
                                          ))}
                                        </ul>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : c.groups ? (
                        <>
                          <span className="font-medium">{c.label}:</span>
                          <ul className="mt-1 list-disc space-y-1 pl-5">
                            {c.groups.map((g) => (
                              <li key={g.text}>
                                {g.text}
                                {g.items && g.items.length > 0 && (
                                  <ListTag ordered={g.ordered}>
                                    {g.items.map((i, n) => (
                                      <li key={`${n}:${i}`}>{i}</li>
                                    ))}
                                  </ListTag>
                                )}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <>
                          <span className="font-medium">{c.label}: </span>
                          {c.text}
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Based on published specifications and any corrections/additions. Unknown stats are labeled as such, not guessed.</p>
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
          )
          const finders = (
          <div>
          {shortfall && !shared && finding && <SwitchFinder plan={derivedLines} products={offered} derived={derived ?? []} powering={powering} onAdd={(added, replacing) => {
            for (const r of replacing) mine.remove(lineKey(r))
            for (const l of added) mine.add(l)
          }} onClose={() => setFinding(false)} />}
          {roleShortfall && !shared && findingRoles && <RoleFinder plan={derivedLines} products={offered} derived={derived ?? []} hosting={hosting} onHost={(role) => mine.host(role, 'self')} onAdd={(added, replacing) => {
            for (const r of replacing) mine.remove(lineKey(r))
            for (const l of added) mine.add(l)
          }} onClose={() => setFindingRoles(false)} />}
          {nvrShortfall && !shared && findingNvr && <NvrFinder plan={derivedLines} products={offered} derived={derived ?? []} onAdd={(added, replacing) => {
            for (const r of replacing) mine.remove(lineKey(r))
            for (const l of added) mine.add(l)
          }} onClose={() => setFindingNvr(false)} />}
          </div>
          )
          const topologyCard = topology && <TopologyGraph topology={topology} open={wide} />
          return wide ? (
            <>
              {topologyCard}
              <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,4fr)] items-start gap-x-6">
                <div>
                  {planCard}
                  {finders}
                </div>
                <div>{checksCard}</div>
              </div>
            </>
          ) : (
            <>
              {planCard}
              {topologyCard}
              {checksCard}
              {finders}
            </>
          )
        })()
      )}
    </main>
  )
}
