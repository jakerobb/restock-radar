import { useState, type FormEvent } from 'react'
import { ApiError } from '../api/client'
import { useAddProduct } from '../api/queries'
import { useRegion } from '../hooks/useRegion'
import { Button } from './ui/Button'
import { Notice } from './ui/Notice'
import { TextInput } from './ui/TextInput'

/** Adds a product by slug or store URL, and reports what happened. The region starts as the one the site is showing. */
export function AddProductForm({ regions }: { regions: string[] }) {
  const [item, setItem] = useState('')
  const [chosen, setRegion] = useState<string | null>(null)
  const { region: shown } = useRegion()
  const region = chosen ?? (regions.includes(shown) ? shown : (regions[0] ?? ''))
  const add = useAddProduct()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!item.trim()) return
    add.mutate({ item, region: regions.length > 1 ? region : undefined }, { onSuccess: () => setItem('') })
  }

  return (
    <div>
      <form className="flex flex-wrap gap-2" onSubmit={submit}>
        <TextInput
          className="min-w-64 flex-1"
          value={item}
          onChange={(e) => {
            setItem(e.target.value)
            if (!add.isIdle) add.reset()
          }}
          placeholder="Slug (ucg-fiber) or store URL"
          autoFocus
          aria-label="Product slug or URL"
          autoComplete="off"
          required
        />
        {regions.length > 1 && (
          <select
            className="rounded-lg border border-line bg-surface px-3 py-2 text-ink"
            aria-label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
          >
            {regions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}
        <Button type="submit" disabled={add.isPending}>
          {add.isPending ? 'Adding…' : 'Add'}
        </Button>
      </form>

      {add.isSuccess && (
        <Notice tone="ok" className="mt-3">
          {add.data.already_tracked
            ? `${add.data.title} is already tracked.`
            : `Now tracking ${add.data.title} (${add.data.variants} ${add.data.variants === 1 ? 'variant' : 'variants'}).`}
        </Notice>
      )}
      {add.isError && (
        <Notice tone="bad" className="mt-3">
          {add.error instanceof ApiError ? `Couldn't add that: ${add.error.message}.` : "Couldn't reach the server. Try again."}
        </Notice>
      )}
    </div>
  )
}
