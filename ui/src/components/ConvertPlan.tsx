import { useMemo, useState } from 'react'
import type { Product } from '../api/types'
import { convertPlan } from '../lib/convertPlan'
import { encodePlan, type PlanLine } from '../lib/plan'
import { regionName } from '../lib/region'
import type { Powering } from '../lib/powering'
import type { Hosting } from '../lib/roles'
import { Dialog } from './Dialog'
import { Button } from './ui/Button'
import { Notice } from './ui/Notice'
import { Select } from './ui/Select'

const WHY = {
  untracked: "isn't tracked here",
  'not-sold': 'is not sold there',
  'no-variant': 'is sold there, but not in this variant',
} as const

interface ConvertPlanProps {
  /** The plan's name, which the converted plan keeps. */
  name: string
  lines: PlanLine[]
  hosting: Hosting
  powering: Powering
  /** Every tracked product, in every region. */
  products: Product[]
  regions: string[]
  /** The region to offer first. */
  suggested: string
}

/** Offers to make the plan again from another store's products, opened as a new plan (in a new tab) so the two can be compared. */
export function ConvertPlan({ name, lines, hosting, powering, products, regions, suggested }: ConvertPlanProps) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState(suggested)
  const conversion = useMemo(() => (open ? convertPlan(lines, powering, products, target) : null), [open, lines, powering, products, target])
  if (regions.length < 2 || lines.length === 0) return null
  const slug = conversion && conversion.lines.length > 0 ? encodePlan(conversion.lines, products, hosting, conversion.powering, name) : ''
  const counterparts = conversion?.outcomes.filter((o) => o.result === 'counterpart') ?? []
  const left = conversion?.outcomes.filter((o) => o.result === 'left') ?? []
  return (
    <>
      <Button
        variant="secondary"
        className="py-1 text-sm"
        onClick={() => {
          setTarget(suggested)
          setOpen(true)
        }}
      >
        Convert to another region
      </Button>
      {open && conversion && (
        <Dialog title="Convert this plan" onClose={() => setOpen(false)}>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Region:</span>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} className="py-1" data-autofocus>
              {regions.map((r) => (
                <option key={r} value={r}>
                  {regionName(r)}
                </option>
              ))}
            </Select>
          </label>
          <p className="mt-3 text-sm">
            {conversion.lines.length === 0
              ? `Nothing in this plan is sold in ${regionName(target)}.`
              : `${conversion.lines.length} of ${lines.length} ${lines.length === 1 ? 'line carries' : 'lines carry'} over to ${regionName(target)}, at that store's prices and in its currency.`}
          </p>
          {counterparts.length > 0 && (
            <p className="mt-2 text-sm text-muted">
              Sold there under another SKU: {counterparts.map((o) => `${o.title} (${o.line.sku} is ${o.to?.sku})`).join('; ')}.
            </p>
          )}
          {left.length > 0 && (
            <Notice tone="bad" className="mt-3 text-sm">
              Left out:
              <ul className="mt-1 list-disc pl-5">
                {left.map((o) => (
                  <li key={`${o.line.ref}:${o.line.sku}`}>
                    {o.title} {o.why ? WHY[o.why] : ''}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {slug !== '' ? (
              <a
                href={`/plan/${slug}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:opacity-90"
              >
                Open the converted plan in a new tab
              </a>
            ) : null}
            <span className="text-sm text-muted">Your plan isn't changed. The new one opens as a shared plan, which you can keep from there.</span>
          </div>
        </Dialog>
      )}
    </>
  )
}
