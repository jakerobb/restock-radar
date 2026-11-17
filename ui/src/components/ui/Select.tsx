import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'rounded-lg border border-line bg-surface px-2.5 py-2 text-ink',
        'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent',
        className,
      )}
      {...props}
    />
  )
}
