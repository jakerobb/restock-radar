import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { toneClasses } from './tone'

interface NoticeProps {
  tone: 'ok' | 'bad'
  children: ReactNode
  className?: string
}

/** A message banner; errors are announced assertively. */
export function Notice({ tone, children, className }: NoticeProps) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cn('rounded-lg px-3.5 py-2.5', toneClasses[tone], className)}>
      {children}
    </div>
  )
}
