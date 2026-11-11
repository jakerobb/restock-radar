import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

interface ButtonProps extends ComponentProps<'button'> {
  /** `primary` is the filled call to action; `secondary` is an outlined button for everyday actions. */
  variant?: 'primary' | 'secondary'
}

export function Button({ variant = 'primary', className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'cursor-pointer rounded-lg px-4 py-2 font-medium',
        variant === 'primary'
          ? 'bg-accent text-on-accent hover:opacity-90'
          : 'border border-line bg-surface font-normal text-ink hover:border-accent',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
