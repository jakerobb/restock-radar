import { useId, useState, type ReactNode } from 'react'
import { useDeleteOverride, useOverrideHistory, useSaveOverride } from '../api/queries'
import type { OverrideChange, OverrideRequest, SpecEntry, SpecOverride } from '../api/types'
import { formatRelative } from '../lib/format'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Select } from './ui/Select'
import { TextInput } from './ui/TextInput'

/** The entry an override is about: where the store files it. */
export interface Target {
  section: string
  group: string
  label: string
}

const textarea =
  'rounded-lg border border-line bg-surface px-3 py-2 text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent'

function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${className ?? ''}`}>
      <span className="text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  )
}

interface FormProps {
  region: string
  slug: string
  target: Target
  /** The entry's current value and kind, when editing one that exists. */
  initial?: { kind: string; value: string; note: string; source_url: string; reason: string }
  /** What the store published, shown so the correction is made knowingly. */
  published?: string
  /** Offered when the entry is itself an override: put it back as it was (or remove what was added). */
  revert?: { id: number; label: string }
  /** Offered for a published entry: leave it out. */
  canHide: boolean
  onDone: () => void
}

/** Edits, hides or reverts one entry of a product's specification, as an override. */
function EntryForm({ region, slug, target, initial, published, revert, canHide, onDone }: FormProps) {
  const save = useSaveOverride(region, slug)
  const remove = useDeleteOverride(region, slug)
  const [kind, setKind] = useState(initial?.kind === 'flag' ? 'flag' : 'text')
  const [value, setValue] = useState(initial?.value ?? '')
  const [note, setNote] = useState(initial?.note ?? '')
  const [source, setSource] = useState(initial?.source_url ?? '')
  const [reason, setReason] = useState(initial?.reason ?? '')
  const busy = save.isPending || remove.isPending
  const error = save.error ?? remove.error

  const send = (action: OverrideRequest['action']) => {
    const req: OverrideRequest = { region, slug, action, section: target.section, group: target.group || undefined, label: target.label, source_url: source.trim() || undefined, reason: reason.trim() || undefined }
    if (action === 'set') Object.assign(req, { kind, value: value.trim(), note: note.trim() || undefined })
    save.mutate(req, { onSuccess: onDone })
  }

  return (
    <form
      aria-label={`Correct ${target.label}`}
      className="mt-2 space-y-3 rounded-lg border border-line bg-canvas p-3"
      onSubmit={(e) => {
        e.preventDefault()
        send('set')
      }}
    >
      {published !== undefined && <p className="text-xs text-muted">The store publishes: {published || '(nothing)'}</p>}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field label="Value" hint='Written as the store writes it ("8 Gbps", "PoE++ out"): the same parsers read it.'>
          {kind === 'flag' ? (
            <Select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value">
              <option value="">Choose…</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
          ) : (
            <textarea className={textarea} rows={2} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value" />
          )}
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => (setKind(e.target.value), setValue(''))} aria-label="Kind">
            <option value="text">Text</option>
            <option value="flag">Yes / no</option>
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Source (URL)" hint="Where the correction comes from.">
          <TextInput value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://…" aria-label="Source URL" />
        </Field>
        <Field label="Reason">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. measured in a teardown" aria-label="Reason" />
        </Field>
      </div>
      <Field label="Note" hint="Replaces the footnote the store publishes, when set.">
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" className="px-3 text-sm" disabled={busy}>
          {save.isPending ? 'Saving…' : 'Save correction'}
        </Button>
        {canHide && (
          <Button type="button" variant="secondary" className="px-3 text-sm" disabled={busy} onClick={() => send('hide')}>
            Hide this entry
          </Button>
        )}
        {revert && (
          <Button type="button" variant="secondary" className="px-3 text-sm" disabled={busy} onClick={() => remove.mutate(revert.id, { onSuccess: onDone })}>
            {revert.label}
          </Button>
        )}
        <Button type="button" variant="secondary" className="px-3 text-sm" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        {error && (
          <span role="alert" className="text-sm text-bad">
            {error.message}
          </span>
        )}
      </div>
    </form>
  )
}

interface EntryEditorProps {
  region: string
  slug: string
  entry: SpecEntry
  /** The group heading the entry sits under, if any. */
  group: string
  /** The entry's override, when it has one. */
  override?: SpecOverride
}

/** The Correct button of a specification entry, and the form it opens. */
export function EntryEditor({ region, slug, entry, group, override }: EntryEditorProps) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} aria-label={`Correct ${entry.label}`} className="mt-1 block cursor-pointer text-xs text-accent underline-offset-2 hover:underline">
        Correct
      </button>
    )
  }
  const overridden = entry.origin !== 'published'
  return (
    <EntryForm
      region={region}
      slug={slug}
      target={{ section: entry.section, group, label: entry.label }}
      initial={{ kind: entry.kind, value: entry.value ?? '', note: entry.note ?? '', source_url: override?.source_url ?? '', reason: override?.reason ?? '' }}
      published={entry.origin === 'override' ? (entry.published_value ?? '') : entry.origin === 'published' ? (entry.value ?? '') : undefined}
      revert={overridden && entry.override_id ? { id: entry.override_id, label: entry.origin === 'added' ? 'Remove this entry' : 'Revert to published' } : undefined}
      canHide={entry.origin !== 'added'}
      onDone={() => setOpen(false)}
    />
  )
}

/** Adds a fact the store doesn't publish at all (something a teardown found, say). */
export function AddFact({ region, slug, sections }: { region: string; slug: string; sections: string[] }) {
  const save = useSaveOverride(region, slug)
  const list = useId()
  const [section, setSection] = useState('')
  const [group, setGroup] = useState('')
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState('text')
  const [value, setValue] = useState('')
  const [source, setSource] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')

  const reset = () => {
    setLabel('')
    setValue('')
    setNote('')
    setSource('')
    setReason('')
    setGroup('')
  }
  return (
    <Card aria-label="Add a fact">
      <h2 className="mb-1 text-lg font-semibold">Add a fact</h2>
      <p className="mb-3 text-sm text-muted">For something the store doesn't publish for this product. It is kept as an override, beside the published specification.</p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(
            { region, slug, action: 'set', section: section.trim(), group: group.trim() || undefined, label: label.trim(), kind: kind === 'flag' ? 'flag' : 'text', value: value.trim(), note: note.trim() || undefined, source_url: source.trim() || undefined, reason: reason.trim() || undefined },
            { onSuccess: reset },
          )
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Section">
            <TextInput list={list} value={section} onChange={(e) => setSection(e.target.value)} placeholder="Hardware" aria-label="Section" required />
            <datalist id={list}>
              {sections.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field label="Group (optional)">
            <TextInput value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group" />
          </Field>
          <Field label="Label">
            <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Max. Bitrate" aria-label="Label" required />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field label="Value">
            {kind === 'flag' ? (
              <Select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value" required>
                <option value="">Choose…</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            ) : (
              <TextInput value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value" required />
            )}
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => (setKind(e.target.value), setValue(''))} aria-label="Kind">
              <option value="text">Text</option>
              <option value="flag">Yes / no</option>
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source (URL)">
            <TextInput value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://…" aria-label="Source URL" />
          </Field>
          <Field label="Reason">
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          </Field>
        </div>
        <Field label="Note">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" className="px-3 text-sm" disabled={save.isPending}>
            {save.isPending ? 'Adding…' : 'Add fact'}
          </Button>
          {save.isSuccess && (
            <span role="status" className="text-sm text-muted">
              Added.
            </span>
          )}
          {save.isError && (
            <span role="alert" className="text-sm text-bad">
              {save.error.message}
            </span>
          )}
        </div>
      </form>
    </Card>
  )
}

/** A short statement of what an override says. */
function overrideSummary(o: Pick<SpecOverride, 'action' | 'label' | 'value'>): string {
  return o.action === 'hide' ? `hid “${o.label}”` : `set “${o.label}” to ${o.value}`
}

/** Removes an override. */
export function RemoveOverrideButton({ region, slug, id, label }: { region: string; slug: string; id: number; label: string }) {
  const remove = useDeleteOverride(region, slug)
  return (
    <span className="ml-2 inline-flex items-center gap-2">
      <button
        type="button"
        disabled={remove.isPending}
        onClick={() => remove.mutate(id)}
        aria-label={`Remove the correction to ${label}`}
        className="cursor-pointer text-xs text-accent underline-offset-2 hover:underline disabled:opacity-50"
      >
        {remove.isPending ? 'Removing…' : 'Remove'}
      </button>
      {remove.isError && (
        <span role="alert" className="text-xs text-bad">
          {remove.error.message}
        </span>
      )}
    </span>
  )
}

const VERB: Record<OverrideChange['change'], string> = { create: 'added', update: 'changed', delete: 'removed' }

function describeChange(c: OverrideChange): string {
  const o = c.after ?? c.before
  const what = o ? o.label : 'an override'
  if (c.change === 'update' && c.before && c.after) {
    return `changed “${what}”: ${c.before.action === 'hide' ? 'hidden' : c.before.value} → ${c.after.action === 'hide' ? 'hidden' : c.after.value}`
  }
  return `${VERB[c.change]} ${o ? overrideSummary(o) : what}`
}

/** Who changed which corrections, and what they were before: for those who review them. */
export function OverrideHistory({ region, slug }: { region: string; slug: string }) {
  const { data, isError, isPending } = useOverrideHistory(region, slug, true)
  return (
    <Card aria-label="Correction history">
      <h2 className="mb-1 text-lg font-semibold">History of corrections</h2>
      {isPending && <p className="text-sm text-muted">Loading…</p>}
      {isError && <p className="text-sm text-bad">Couldn't load the history.</p>}
      {data && data.length === 0 && <p className="text-sm text-muted">No corrections have been made to this product.</p>}
      {data && data.length > 0 && (
        <ol className="space-y-1.5 text-sm">
          {data.map((c) => (
            <li key={c.id}>
              <time dateTime={c.at} className="text-muted">
                {formatRelative(c.at)}
              </time>{' '}
              <Badge tone="neutral">{c.actor}</Badge> {describeChange(c)}
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}
