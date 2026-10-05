import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

/** A bordered surface. Layout inside it is the caller's business. */
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('rounded-xl border border-line bg-surface p-4', className)} {...props} />
}
