import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export function TextInput({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type="text"
      className={cn(
        'rounded-lg border border-line bg-surface px-3 py-2 text-ink placeholder:text-muted',
        'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent',
        className,
      )}
      {...props}
    />
  )
}
