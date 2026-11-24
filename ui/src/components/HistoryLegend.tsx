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
            <rect x="0.5" y="0.5" width="9" height="9" className={`${stockFill[statusInfo(status).tone]} stroke-muted`} />
          </svg>
          {statusInfo(status).label}
        </li>
      ))}
      <li className="flex items-center gap-1">
        <svg width="10" height="10" aria-hidden="true">
          <rect x="0.5" y="0.5" width="9" height="9" className="fill-chart-empty stroke-muted" />
        </svg>
        Not listed or not tracked
      </li>
    </ul>
  )
}
