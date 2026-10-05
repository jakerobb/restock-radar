import { statusInfo } from '../lib/status'
import { Badge } from './ui/Badge'

/** A variant's stock status as a coloured pill. */
export function StatusBadge({ status }: { status: string }) {
  const { label, tone } = statusInfo(status)
  return <Badge tone={tone}>{label}</Badge>
}
