import type { CatalogRow } from '../lib/catalog'
import { idsSteps, isFiltering, NO_FILTERS, type FinderFilters } from '../lib/finderFilters'
import { formatRate } from '../lib/roles'
import { Select } from './ui/Select'

interface Props {
  filters: FinderFilters
  onChange: (next: FinderFilters) => void
  /** The catalogue, for the throughputs on offer; given where gateways are among what is being found. */
  gatewayRows?: CatalogRow[]
  /** Leave out the hot-swappable power supplies box, for a finder that puts it elsewhere. */
  hideHotSwap?: boolean
}

const check = 'inline-flex cursor-pointer items-center gap-1.5'

/** What a plan's finder can be narrowed to. The gateway ones only show where gateways are among the suggestions. */
export function FinderFilterBar({ filters, onChange, gatewayRows, hideHotSwap = false }: Props) {
  const set = (over: Partial<FinderFilters>) => onChange({ ...filters, ...over })
  return (
    <fieldset className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <legend className="sr-only">Narrow the suggestions</legend>
      <label className={check}>
        <input type="checkbox" checked={filters.inStock} onChange={(e) => set({ inStock: e.target.checked })} />
        In stock only
      </label>
      <label className="inline-flex items-center gap-1.5">
        <span className="text-muted">Mounting:</span>
        <Select className="py-1 text-sm" aria-label="Mounting" value={filters.rack} onChange={(e) => set({ rack: e.target.value as FinderFilters['rack'] })}>
          <option value="any">Any</option>
          <option value="rack">Rackmount</option>
          <option value="desk">Not rackmount</option>
        </Select>
      </label>
      {!hideHotSwap && <HotSwapBox filters={filters} onChange={onChange} />}
      {gatewayRows && (
        <>
          <label className={check}>
            <input type="checkbox" checked={filters.pppoe} onChange={(e) => set({ pppoe: e.target.checked })} />
            Hardware PPPoE acceleration
          </label>
          <label className={check}>
            <input type="checkbox" checked={filters.shadow} onChange={(e) => set({ shadow: e.target.checked })} />
            Shadow mode
          </label>
          <label className="inline-flex items-center gap-1.5">
            <span className="text-muted">IDS/IPS:</span>
            <Select className="py-1 text-sm" aria-label="Minimum IDS/IPS throughput" value={filters.minIdsMbps} onChange={(e) => set({ minIdsMbps: Number(e.target.value) })}>
              <option value={0}>Any throughput</option>
              {idsSteps(gatewayRows).map((v) => (
                <option key={v} value={v}>
                  {formatRate(v)} or more
                </option>
              ))}
            </Select>
          </label>
        </>
      )}
      {isFiltering(filters) && (
        <button type="button" className="cursor-pointer text-muted underline underline-offset-2 hover:text-ink" onClick={() => onChange(NO_FILTERS)}>
          Clear filters
        </button>
      )}
    </fieldset>
  )
}

/** The hot-swappable power supplies (CRPS) box. */
export function HotSwapBox({ filters, onChange }: { filters: FinderFilters; onChange: (next: FinderFilters) => void }) {
  return (
    <label className={check}>
      <input type="checkbox" checked={filters.hotSwap} onChange={(e) => onChange({ ...filters, hotSwap: e.target.checked })} />
      Hot-swappable power supplies (CRPS)
    </label>
  )
}
