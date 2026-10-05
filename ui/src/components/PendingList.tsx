import type { PendingItem } from '../api/types'
import { Card } from './ui/Card'

/** Items on the watch list that haven't been checked successfully yet. */
export function PendingList({ items }: { items: PendingItem[] }) {
  if (items.length === 0) return null
  return (
    <Card className="text-muted">
      Waiting for a first check:
      <ul className="mt-1.5 list-disc pl-5">
        {items.map((item) => (
          <li key={`${item.region}/${item.slug}`}>
            {item.region}/{item.slug}
          </li>
        ))}
      </ul>
    </Card>
  )
}
