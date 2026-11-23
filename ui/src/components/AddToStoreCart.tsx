import { useCallback, useMemo, useState } from 'react'
import type { LineView } from '../lib/plan'
import { regionName } from '../lib/region'
import { bookmarkletHref, bookmarkletSource, cartPayload, storeCarts, storeUrl, type StoreCart } from '../lib/storeCart/storeCart'
import { Dialog } from './Dialog'
import { Button } from './ui/Button'
import { Select } from './ui/Select'

/**
 * The link for the bookmarks bar. React won't render a `javascript:` href (it swaps in code that throws), so it's put on the
 * element by hand. Clicking it here does nothing (the page's policy would stop it anyway): it is only ever dragged or copied.
 */
function BookmarkletLink() {
  const ref = useCallback((el: HTMLAnchorElement | null) => el?.setAttribute('href', bookmarkletHref()), [])
  return (
    <a
      ref={ref}
      onClick={(e) => e.preventDefault()}
      className="inline-block cursor-grab rounded-lg border border-dashed border-accent bg-surface px-3 py-1.5 text-sm font-medium text-accent"
      title="Drag this to your bookmarks bar"
    >
      ➕ Add plan to UniFi cart
    </a>
  )
}

function CartSection({ cart, name }: { cart: StoreCart; name: string }) {
  const units = cart.items.reduce((n, it) => n + it.qty, 0)
  const url = storeUrl(cart, name)
  const open = () => {
    if (!url) return
    // Opened first, while the click still counts; the clipboard copy is the fallback if the fragment is lost on the way.
    window.open(url, '_blank', 'noopener')
    void navigator.clipboard?.writeText(cartPayload(name, cart.region, cart.items)).catch(() => undefined)
  }
  return (
    <section className="mt-4 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">
          {regionName(cart.region)} store: {cart.items.length} {cart.items.length === 1 ? 'product' : 'products'}, {units} {units === 1 ? 'unit' : 'units'}
        </h3>
        <Button className="py-1 text-sm" onClick={open} disabled={cart.items.length === 0 || !url}>
          Open the store with this plan
        </Button>
      </div>
      {cart.items.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm">
          {cart.items.map((it) => (
            <li key={it.id}>
              {it.qty} × {it.title} <span className="text-muted">({it.sku})</span>
            </li>
          ))}
        </ul>
      )}
      {cart.skipped.length > 0 && (
        <div className="mt-2 text-sm text-muted">
          Left out:{' '}
          {cart.skipped.map((s, i) => (
            <span key={i}>
              {i > 0 && '; '}
              {s.title} ({s.why})
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

/** "Add to UniFi cart": a bookmarklet that fills the store's own cart from the plan. */
export function AddToStoreCart({ name, views, region }: { name: string; views: LineView[]; /** The region the site is showing; a plan that spans several starts on it. */ region?: string }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const carts = useMemo(() => (open ? storeCarts(views) : []), [open, views])
  if (views.length === 0) return null
  // One store at a time: the cart is the visitor's at that store alone, and the bookmark refuses another's plan.
  const chosen = carts.find((c) => c.region === picked) ?? carts.find((c) => c.region === region) ?? carts[0]
  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(`javascript:${bookmarkletSource()}`)
      setCopied(true)
    } catch {
      // Nothing to copy to; the link can still be dragged.
    }
  }
  return (
    <>
      <Button variant="secondary" className="py-1 text-sm" onClick={() => setOpen(true)}>
        Add to UniFi cart
      </Button>
      {open && (
        <Dialog
          title="Add this plan to the UniFi store cart"
          size="wide"
          onClose={() => {
            setOpen(false)
            setCopied(false)
            setPicked(null)
          }}
        >
          <p className="text-sm text-muted">
            The store can’t be reached from here, so this uses a bookmark that runs on the store’s own page, with your own cart and sign-in. Nothing is sent to anyone but the store, and nothing is bought.
          </p>
          <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm">
            <li>
              <strong>Once:</strong> drag this to your bookmarks bar.
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <BookmarkletLink />
                <button type="button" className="cursor-pointer text-sm underline underline-offset-2" onClick={() => void copySource()}>
                  {copied ? 'Copied: paste it as a bookmark’s address' : 'or copy it, to paste as a bookmark’s address'}
                </button>
              </div>
            </li>
            <li>
              Open the store with the plan from the button below. If the store was already open, no matter: the button also copies the plan.
            </li>
            <li>
              On the store page, <strong>click the bookmark</strong>. It shows what it will add and asks first; items already in your cart count toward the plan, so running it again adds nothing more. Then it opens your cart.
            </li>
          </ol>
          {carts.length > 1 && chosen && (
            <label className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              This plan buys from {carts.length} stores, which have separate carts. Do:
              <Select className="py-1" value={chosen.region} onChange={(e) => setPicked(e.target.value)} aria-label="Store">
                {carts.map((c) => (
                  <option key={c.region} value={c.region}>
                    {regionName(c.region)} ({c.items.length})
                  </option>
                ))}
              </Select>
            </label>
          )}
          {chosen && <CartSection key={chosen.region} cart={chosen} name={name} />}
          <p className="mt-4 text-xs text-muted">
            The store changes without warning and this follows its pages by hand. If the bookmark says something went wrong, it may need an update here, after which you drag the link again.
          </p>
        </Dialog>
      )}
    </>
  )
}
