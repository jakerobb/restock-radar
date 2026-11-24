import { useMemo, useState } from 'react'
import { useUnifiDevices } from '../api/queries'
import type { Product } from '../api/types'
import { usePlan } from '../hooks/usePlan'
import { formatPrice } from '../lib/format'
import { MAX_LINES } from '../lib/plan'
import { MAX_PLANS, uniqueName } from '../lib/planStore'
import { regionName } from '../lib/region'
import { ImportError, readUnifiFile, type FoundDevice } from '../lib/unifiImport'
import { matchDevices, type ImportRow } from '../lib/unifiImport/match'
import { Dialog } from './Dialog'
import { Button } from './ui/Button'
import { Notice } from './ui/Notice'

const LIST = 'mt-1 max-h-[14rem] list-disc overflow-y-auto pl-5'

const WHY = {
  'not-tracked': 'isn’t one this store lists',
  unknown: 'couldn’t be told from what the file says',
} as const

interface ImportUnifiProps {
  /** The products of the store the plan is for. */
  products: Product[]
  region: string
}

/**
 * Offers to make a plan from the equipment a UniFi console already has: you give it a support file or a Network
 * backup from the console, it reads that here in the browser (nothing is sent anywhere, and only each device's model
 * is kept) and lists what it found as products you can add. The result is a new plan; none of yours is changed.
 */
export function ImportUnifi({ products, region }: ImportUnifiProps) {
  const [open, setOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [found, setFound] = useState<FoundDevice[] | null>(null)
  const [left, setLeft] = useState<Set<string>>(new Set())
  const { plans, create } = usePlan()
  const infos = useUnifiDevices(open && found !== null)
  const rows = useMemo(() => (found && infos.data ? matchDevices(found, infos.data.devices, products) : null), [found, infos.data, products])

  const close = () => {
    setOpen(false)
    setFound(null)
    setError('')
    setLeft(new Set())
  }

  const read = async (file: File | undefined) => {
    if (!file) return
    setReading(true)
    setError('')
    setFound(null)
    try {
      setFound(await readUnifiFile(file))
      setLeft(new Set())
    } catch (e) {
      setError(e instanceof ImportError ? e.message : 'That file couldn’t be read.')
    } finally {
      setReading(false)
    }
  }

  const matched = rows?.filter((r) => r.state === 'matched') ?? []
  const unmatched = rows?.filter((r) => r.state !== 'matched') ?? []
  const chosen = matched.filter((r) => !left.has(r.id)).slice(0, MAX_LINES)
  const devices = chosen.reduce((n, r) => n + (r.line?.qty ?? 0), 0)
  const full = plans.length >= MAX_PLANS

  const make = () => {
    // What a console has adopted is owned already, so none of it is to be bought.
    const lines = chosen.flatMap((r) => (r.line ? [{ ...r.line, owned: r.line.qty }] : []))
    if (lines.length === 0) return
    if (create(uniqueName(plans, 'UniFi import'), lines) === null) {
      setError(`You already have ${MAX_PLANS} plans; delete one first.`)
      return
    }
    close()
  }

  return (
    <>
      <Button variant="secondary" className="py-1 text-sm" onClick={() => setOpen(true)}>
        Import from UniFi
      </Button>
      {open && (
        <Dialog title="Import from UniFi" size="wide" onClose={close}>
          <p className="text-sm text-muted">
            Make a plan from the equipment a UniFi console already has. Choose a <strong className="text-ink">support file</strong> (the one with UniFi Network in it is the quickest) or a <strong className="text-ink">UniFi Network backup</strong> (.unf).
            The file is read in your browser and isn’t sent anywhere; only the model of each device is kept, and the rest of it (passwords, keys, addresses) is never looked at.
          </p>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="text-muted">File</span>
            <input
              type="file"
              accept=".tgz,.gz,.unf,.unifi"
              data-autofocus
              onChange={(e) => void read(e.target.files?.[0])}
              className="block w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-2 text-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-accent file:px-3 file:py-1 file:text-on-accent"
            />
          </label>
          {reading && <p className="mt-3 text-sm text-muted">Reading…</p>}
          {error !== '' && (
            <Notice tone="bad" className="mt-3 text-sm">
              {error}
            </Notice>
          )}
          {found && infos.isError && (
            <Notice tone="bad" className="mt-3 text-sm">
              Couldn’t load Ubiquiti’s list of devices, which is needed to tell what they are. Try again in a little while.
            </Notice>
          )}
          {found && !rows && !infos.isError && <p className="mt-3 text-sm text-muted">Matching…</p>}
          {rows && (
            <>
              <p className="mt-3 text-sm">
                {found?.length} {found?.length === 1 ? 'device' : 'devices'} found, {matched.reduce((n, r) => n + r.count, 0)} of them sold in the {regionName(region)} store, at its prices.
              </p>
              {matched.length > 0 && (
                <ul className="mt-2 max-h-[18rem] divide-y divide-line overflow-y-auto rounded-lg border border-line text-sm">
                  {matched.map((r) => (
                    <MatchedRow key={r.id} row={r} on={!left.has(r.id)} onToggle={() => setLeft((s) => toggle(s, r.id))} />
                  ))}
                </ul>
              )}
              {unmatched.length > 0 && (
                <div className="mt-3 text-sm text-muted">
                  Not added:
                  <ul className={LIST}>
                    {unmatched.map((r) => (
                      <li key={r.id}>
                        <span className="text-ink">
                          {r.count > 1 && `${r.count} × `}
                          {r.title}
                        </span>{' '}
                        {WHY[r.state as keyof typeof WHY]}
                        {r.title !== r.models[0] && <span className="ml-1.5 text-[0.9em]">({r.models.join(', ')})</span>}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1">You can add these yourself with “Add product”.</p>
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button onClick={make} disabled={chosen.length === 0 || full}>
                  Create a plan of {devices} {devices === 1 ? 'device' : 'devices'}
                </Button>
                <span className="text-sm text-muted">{full ? `You already have ${MAX_PLANS} plans.` : 'It’s a new plan; the ones you have aren’t changed.'}</span>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  )
}

function toggle(s: Set<string>, id: string): Set<string> {
  const next = new Set(s)
  if (!next.delete(id)) next.add(id)
  return next
}

function MatchedRow({ row, on, onToggle }: { row: ImportRow; on: boolean; onToggle: () => void }) {
  const v = row.variant
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
        <input type="checkbox" checked={on} onChange={onToggle} aria-label={`Include ${row.title}`} />
        <span className="min-w-0 flex-1">
          <span className="font-semibold">{row.title}</span>
          {v && <span className="ml-1.5 text-[0.9em] text-muted">{v.title !== '' ? `${v.title} · ` : ''}{v.sku}</span>}
        </span>
        <span className="tabular-nums text-muted">
          {row.line && row.line.addedCents !== null && v ? `${formatPrice(row.line.addedCents, v.currency)} × ` : '× '}
          <span className="text-ink">{row.count}</span>
        </span>
      </label>
    </li>
  )
}
