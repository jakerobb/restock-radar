import { useState } from 'react'
import { AddProductForm } from './AddProductForm'
import { Dialog } from './Dialog'
import { Button } from './ui/Button'

/** A button that opens a dialog for adding a product by slug or store URL. */
export function AddProductDialog({ regions }: { regions: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" variant="secondary" className="px-3 text-sm" onClick={() => setOpen(true)}>
        Add product
      </Button>
      {open && (
        <Dialog title="Add a product" onClose={() => setOpen(false)}>
          <AddProductForm regions={regions} />
        </Dialog>
      )}
    </>
  )
}
