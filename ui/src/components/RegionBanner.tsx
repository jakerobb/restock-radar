import type { ReactNode } from 'react'
import { Notice } from './ui/Notice'

/** A warning that what the page shows isn't from the store the visitor has picked, with whatever fixes it. */
export function RegionBanner({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <Notice tone="warn" className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
      <div>{children}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </Notice>
  )
}
