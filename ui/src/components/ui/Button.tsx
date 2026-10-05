import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export function Button({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      className={cn(
        'cursor-pointer rounded-lg bg-accent px-4 py-2 font-medium text-on-accent',
        'hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
