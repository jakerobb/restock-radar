import { statusInfo } from '../lib/status'
import { stockFill } from './HistoryChart'

const STATUSES = ['Available', 'SoldOut', 'ComingSoon']

/** What the chart backgrounds mean. */
export function HistoryLegend({ days }: { days: number }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 text-xs text-muted" aria-label={`Chart key, last ${days} days`}>
      <li>Last {days} days:</li>
      {STATUSES.map((status) => (
        <li key={status} className="flex items-center gap-1">
          <svg width="10" height="10" aria-hidden="true">
            <rect width="10" height="10" className={`${stockFill[statusInfo(status).tone]} stroke-line`} />
          </svg>
          {statusInfo(status).label}
        </li>
      ))}
    </ul>
  )
}
