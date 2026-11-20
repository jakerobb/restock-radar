import { useState } from 'react'
import { cleanName, MAX_NAME } from '../lib/plan'
import { Dialog } from './Dialog'
import { Button } from './ui/Button'
import { TextInput } from './ui/TextInput'

/**
 * Asks what a plan is to be called, starting from a suggestion that Enter (or the one button) accepts as it is.
 * The name is selected, so typing replaces it.
 */
export function NamePlanDialog({ title, label, initial, submit, taken, onSubmit, onClose }: { title: string; label: string; initial: string; submit: string; /** Whether another plan has this name already. */ taken: (name: string) => boolean; onSubmit: (name: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial)
  const name = cleanName(value)
  const clash = name !== '' && taken(name)
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (name && !clash) onSubmit(name)
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          {label}
          <TextInput data-autofocus autoFocus maxLength={MAX_NAME} value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} aria-invalid={clash} aria-describedby={clash ? 'plan-name-taken' : undefined} />
        </label>
        {clash && (
          <p id="plan-name-taken" role="alert" className="text-sm text-bad">
            You already have a plan called “{name}”.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name || clash}>
            {submit}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
