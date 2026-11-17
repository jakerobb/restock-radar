import type { PowerSource } from '../api/types'

const LABEL: Record<PowerSource['kind'], string> = {
  poe: 'PoE',
  passive_poe: 'Passive PoE',
  ac: 'AC',
  dc: 'DC',
  usb: 'USB',
  battery: 'Battery',
  rps: 'RPS',
  other: 'Other',
}

/** "PoE+", "AC", "Passive PoE": how a way of powering a product reads in a table. */
export const powerLabel = (s: PowerSource): string => (s.kind === 'poe' && s.poe_class ? s.poe_class : (LABEL[s.kind] ?? s.kind))

/** All of a product's ways of being powered, in the order the specification lists them; null when it doesn't say. */
export function powerSummary(sources: PowerSource[] | undefined): string | null {
  return sources && sources.length > 0 ? sources.map(powerLabel).join(', ') : null
}
