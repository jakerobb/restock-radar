import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { toneClasses, type Tone } from './tone'

interface BadgeProps {
  tone: Tone
  children: ReactNode
  className?: string
}

/** A small pill. The only place pill styling is defined. */
export function Badge({ tone, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
