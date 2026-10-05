import { RelativeTime } from './RelativeTime'

interface SyncStatusProps {
  lastSync: string | null
  productCount: number
}

export function SyncStatus({ lastSync, productCount }: SyncStatusProps) {
  return (
    <p className="text-muted">
      {lastSync ? (
        <>
          Last synced <RelativeTime iso={lastSync} />
        </>
      ) : (
        'Not synced yet'
      )}
      {' · '}
      {productCount} {productCount === 1 ? 'product' : 'products'}
    </p>
  )
}
