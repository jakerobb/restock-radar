import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useMe } from '../api/queries'
import { usePlan } from '../hooks/usePlan'
import { RegionPicker } from './RegionPicker'

/** The heading and links shared by the pages other than the home list. */
export function PageNav({ title, children }: { title: string; children?: ReactNode }) {
  const me = useMe().data
  const items = usePlan().lines.reduce((n, l) => n + l.qty, 0)
  const link = 'text-sm text-muted underline underline-offset-2 hover:text-ink'
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h1 className="text-2xl font-bold">{title}</h1>
      <nav aria-label="Pages" className="flex items-center gap-4">
        {me?.authenticated && (
          <span className="text-sm text-muted">
            Signed in as <strong className="font-medium text-ink">{me.name || me.user}</strong>
          </span>
        )}
        {children}
        <RegionPicker />
        <Link to="/" className={link}>
          Products
        </Link>
        <Link to="/find" className={link}>
          Finder
        </Link>
        <Link to="/compare" className={link}>
          Compare
        </Link>
        <Link to="/plan" className={link}>
          Plan{items > 0 ? ` (${items})` : ''}
        </Link>
        <Link to="/status" className={link}>
          Status
        </Link>
      </nav>
    </header>
  )
}
