import { useEffect, useRef, type ReactNode } from 'react'

interface DialogProps {
  title: string
  onClose: () => void
  children: ReactNode
}

/** A modal dialog (native <dialog>: focus trap, Esc to close). Mount it to open it, unmount to close. An element marked data-autofocus gets the focus. */
export function Dialog({ title, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || el.open) return
    if (typeof el.showModal === 'function') el.showModal()
    else el.setAttribute('open', '')
    // showModal puts focus on the first thing it finds (the close button), after React's own autoFocus has run.
    el.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-xl border border-line bg-surface p-5 text-ink backdrop:bg-black/50"
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="cursor-pointer rounded px-2 text-2xl leading-none text-muted hover:text-ink">
          ×
        </button>
      </div>
      {children}
    </dialog>
  )
}
