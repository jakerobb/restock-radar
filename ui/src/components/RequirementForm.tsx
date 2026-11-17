import { useState } from 'react'
import { BANDS, METRICS, PORT_MEDIA, POE_CLASSES, type Requirement } from '../lib/requirements'
import { Button } from './ui/Button'
import { Select } from './ui/Select'
import { TextInput } from './ui/TextInput'

type Kind = Requirement['kind']

const SPEEDS: [string, number][] = [
  ['1 GbE', 1000],
  ['2.5 GbE', 2500],
  ['5 GbE', 5000],
  ['10 GbE', 10000],
  ['25 GbE', 25000],
  ['100 GbE', 100000],
]

const toNumber = (s: string): number | undefined => {
  if (s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  )
}

/** Builds one requirement at a time; the page keeps the list. */
export function RequirementForm({ onAdd }: { onAdd: (r: Requirement) => void }) {
  const [kind, setKind] = useState<Kind>('port')
  const [speed, setSpeed] = useState('')
  const [media, setMedia] = useState('')
  const [poe, setPoe] = useState('')
  const [dir, setDir] = useState('out')
  const [count, setCount] = useState('')
  const [band, setBand] = useState<string>(BANDS[2])
  const [tx, setTx] = useState('')
  const [gain, setGain] = useState('')
  const [metric, setMetric] = useState<string>(METRICS[0]!.name)
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [units, setUnits] = useState('')
  const [error, setError] = useState('')

  const build = (): Requirement | string => {
    switch (kind) {
      case 'port': {
        const n = toNumber(count)
        if (count.trim() !== '' && (n === undefined || n < 1 || !Number.isInteger(n))) return 'How many ports must be a whole number of at least 1.'
        return {
          kind,
          minSpeedMbps: speed ? Number(speed) : undefined,
          media: media || undefined,
          poeClass: poe || undefined,
          // A direction only means something for a port that has PoE.
          poeDirection: poe && (dir === 'out' || dir === 'in') ? dir : undefined,
          minCount: n,
        }
      }
      case 'radio': {
        const t = toNumber(tx)
        const g = toNumber(gain)
        if ((tx.trim() !== '' && t === undefined) || (gain.trim() !== '' && g === undefined)) return 'TX power and antenna gain must be numbers.'
        return { kind, band, minTxDbm: t, minGainDbi: g }
      }
      case 'metric': {
        const lo = toNumber(min)
        const hi = toNumber(max)
        if ((min.trim() !== '' && lo === undefined) || (max.trim() !== '' && hi === undefined)) return 'Minimum and maximum must be numbers.'
        if (lo === undefined && hi === undefined) return 'Give a minimum, a maximum, or both.'
        if (lo !== undefined && hi !== undefined && lo > hi) return 'The minimum is above the maximum.'
        return { kind, name: metric, min: lo, max: hi }
      }
      case 'rack': {
        const u = toNumber(units)
        if (units.trim() !== '' && (u === undefined || !Number.isInteger(u) || u < 1)) return 'Rack height must be a whole number of units.'
        return { kind, maxUnits: u }
      }
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const r = build()
    if (typeof r === 'string') return setError(r)
    setError('')
    onAdd(r)
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3" aria-label="Add a requirement">
      <Field label="I need">
        <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="Kind of requirement">
          <option value="port">a port</option>
          <option value="radio">a radio</option>
          <option value="metric">a number</option>
          <option value="rack">rack mounting</option>
        </Select>
      </Field>

      {kind === 'port' && (
        <>
          <Field label="At least">
            <Select value={speed} onChange={(e) => setSpeed(e.target.value)}>
              <option value="">any speed</option>
              {SPEEDS.map(([label, mbps]) => (
                <option key={mbps} value={mbps}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Connector">
            <Select value={media} onChange={(e) => setMedia(e.target.value)}>
              <option value="">any</option>
              {PORT_MEDIA.map((m) => (
                <option key={m} value={m}>
                  {m.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="PoE at least">
            <Select value={poe} onChange={(e) => setPoe(e.target.value)}>
              <option value="">none needed</option>
              {POE_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="PoE direction">
            <Select value={dir} onChange={(e) => setDir(e.target.value)} disabled={!poe}>
              <option value="out">out (powers devices)</option>
              <option value="in">in (powers this)</option>
              <option value="">either</option>
            </Select>
          </Field>
          <Field label="How many">
            <TextInput inputMode="numeric" className="w-20" value={count} onChange={(e) => setCount(e.target.value)} placeholder="1" />
          </Field>
        </>
      )}

      {kind === 'radio' && (
        <>
          <Field label="Band">
            <Select value={band} onChange={(e) => setBand(e.target.value)}>
              {BANDS.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </Field>
          <Field label="TX power ≥ (dBm)">
            <TextInput inputMode="decimal" className="w-24" value={tx} onChange={(e) => setTx(e.target.value)} />
          </Field>
          <Field label="Antenna gain ≥ (dBi)">
            <TextInput inputMode="decimal" className="w-24" value={gain} onChange={(e) => setGain(e.target.value)} />
          </Field>
        </>
      )}

      {kind === 'metric' && (
        <>
          <Field label="Number">
            <Select value={metric} onChange={(e) => setMetric(e.target.value)}>
              {METRICS.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.label}
                  {m.unit ? ` (${m.unit})` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="At least">
            <TextInput inputMode="decimal" className="w-24" value={min} onChange={(e) => setMin(e.target.value)} />
          </Field>
          <Field label="At most">
            <TextInput inputMode="decimal" className="w-24" value={max} onChange={(e) => setMax(e.target.value)} />
          </Field>
        </>
      )}

      {kind === 'rack' && (
        <Field label="No taller than (U)">
          <TextInput inputMode="numeric" className="w-24" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="any" />
        </Field>
      )}

      <Button type="submit" variant="secondary">
        Add
      </Button>
      {error && (
        <p role="alert" className="basis-full text-sm text-bad">
          {error}
        </p>
      )}
    </form>
  )
}
