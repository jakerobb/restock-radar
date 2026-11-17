import type { Derived, Port } from '../api/types'

/**
 * A requirement is one thing a person needs ("a 10GbE port with PoE+++",
 * "a 6 GHz radio", "at least 200 W of PoE budget"). The finder takes them from
 * the user, saved searches store them, and the system builder will generate
 * them, so this is the shared language: keep it small and well tested.
 *
 * Matching has three outcomes. "unknown" means the specification doesn't say
 * (see Derived.known): it is never treated as "no".
 */
export type Requirement =
  | {
      kind: 'port'
      /** Fastest speed the port runs, in Mbps. */
      minSpeedMbps?: number
      /** "rj45", "sfp+", ...; any when absent. */
      media?: string
      /** The lowest PoE class the port must carry; any (or none) when absent. */
      poeClass?: string
      poeDirection?: 'out' | 'in'
      /** How many such ports; one when absent. */
      minCount?: number
    }
  | { kind: 'radio'; band: string; minTxDbm?: number; minGainDbi?: number }
  | { kind: 'metric'; name: string; min?: number; max?: number }
  | { kind: 'rack'; maxUnits?: number }

export type Verdict = 'match' | 'no' | 'unknown'

export interface Outcome {
  verdict: Verdict
  /** What satisfied the requirement, or why it couldn't be judged; for display. */
  detail: string
}

export const POE_CLASSES = ['PoE', 'PoE+', 'PoE++', 'PoE+++'] as const
const poeRank = (c: string) => POE_CLASSES.indexOf(c as (typeof POE_CLASSES)[number]) + 1

export const PORT_MEDIA = ['rj45', 'sfp', 'sfp+', 'sfp28', 'qsfp28'] as const
export const BANDS = ['2.4 GHz', '5 GHz', '6 GHz', '60 GHz', 'Bluetooth', 'SuperLink'] as const

/** The numbers a person can sort and filter by. */
export interface MetricInfo {
  name: string
  label: string
  unit: string
  /** True when a smaller number is better (power draw). */
  lowerIsBetter?: boolean
}

export const METRICS: readonly MetricInfo[] = [
  { name: 'poe_budget_w', label: 'PoE budget', unit: 'W' },
  { name: 'power_draw_max_w', label: 'Max power draw', unit: 'W', lowerIsBetter: true },
  { name: 'power_draw_excl_poe_w', label: 'Power draw (excl. PoE)', unit: 'W', lowerIsBetter: true },
  { name: 'switching_capacity_gbps', label: 'Switching capacity', unit: 'Gbps' },
  { name: 'nonblocking_throughput_gbps', label: 'Non-blocking throughput', unit: 'Gbps' },
  { name: 'forwarding_rate_mpps', label: 'Forwarding rate', unit: 'Mpps' },
  { name: 'ids_ips_throughput_mbps', label: 'IDS/IPS throughput', unit: 'Mbps' },
  { name: 'wifi_generation', label: 'Wi-Fi generation', unit: '' },
  { name: 'coverage_sqft', label: 'Coverage area', unit: 'ft²' },
  { name: 'coverage_m2', label: 'Coverage area', unit: 'm²' },
  { name: 'range_m', label: 'Link range', unit: 'm' },
]

export const metricInfo = (name: string): MetricInfo | undefined => METRICS.find((m) => m.name === name)

/** Data ports are the ones that carry traffic; console, management and antenna ports don't count. */
const dataPorts = (d: Derived): Port[] => d.ports.filter((p) => p.role === 'data')

/** "10 GbE" for 10000, "2.5 GbE", "100 Mbps". */
export function formatSpeed(mbps: number): string {
  if (mbps >= 1000) return `${mbps / 1000} GbE`
  return `${mbps} Mbps`
}

function matchPorts(r: Extract<Requirement, { kind: 'port' }>, d: Derived): Outcome {
  if (!d.known.ports) return { verdict: 'unknown', detail: "ports aren't known" }
  const need = r.minCount ?? 1
  let sure = 0
  let maybe = 0
  const names: string[] = []
  for (const p of dataPorts(d)) {
    if (r.media && p.media !== r.media) continue
    if (r.poeClass && poeRank(p.poe_class) < poeRank(r.poeClass)) continue
    let uncertain = false
    if (r.minSpeedMbps !== undefined) {
      if (p.max_speed_mbps === 0) uncertain = true
      else if (p.max_speed_mbps < r.minSpeedMbps) continue
    }
    if (r.poeDirection) {
      // A port with no PoE has no direction to speak of; a PoE port whose direction isn't stated might be either.
      if (p.poe_class === '') continue
      if (p.poe_direction === '') uncertain = true
      else if (p.poe_direction !== r.poeDirection) continue
    }
    if (uncertain) maybe += p.count
    else {
      sure += p.count
      names.push(`${p.count} × ${p.label}${p.poe_class ? ` (${p.poe_class}${p.poe_direction ? ` ${p.poe_direction}` : ''})` : ''}`)
    }
  }
  if (sure >= need) return { verdict: 'match', detail: names.join(', ') }
  if (sure + maybe >= need) return { verdict: 'unknown', detail: "a port's speed or PoE direction isn't stated" }
  return { verdict: 'no', detail: 'no such port' }
}

function matchRadio(r: Extract<Requirement, { kind: 'radio' }>, d: Derived): Outcome {
  if (!d.known.radios) return { verdict: 'unknown', detail: "radios aren't known" }
  let maybe = false
  for (const radio of d.radios.filter((x) => x.band === r.band)) {
    const checks: [number | null, number | undefined][] = [
      [radio.tx_power_dbm, r.minTxDbm],
      [radio.antenna_gain_dbi, r.minGainDbi],
    ]
    if (checks.every(([v, min]) => min === undefined || (v !== null && v >= min))) {
      const bits = [radio.tx_power_dbm !== null && `${radio.tx_power_dbm} dBm`, radio.antenna_gain_dbi !== null && `${radio.antenna_gain_dbi} dBi`].filter(Boolean)
      return { verdict: 'match', detail: `${r.band} radio${bits.length ? ` (${bits.join(', ')})` : ''}` }
    }
    if (checks.every(([v, min]) => min === undefined || v === null || v >= min)) maybe = true
  }
  return maybe ? { verdict: 'unknown', detail: `${r.band} radio's figures aren't stated` } : { verdict: 'no', detail: `no ${r.band} radio` }
}

function matchMetric(r: Extract<Requirement, { kind: 'metric' }>, d: Derived): Outcome {
  const info = metricInfo(r.name)
  const m = d.metrics.find((x) => x.name === r.name)
  if (!m) {
    // A product whose PoE facts were read and that gives no budget has none to offer.
    if (r.name === 'poe_budget_w' && d.known.poe) return { verdict: 'no', detail: 'no PoE budget' }
    return { verdict: 'unknown', detail: `${info?.label ?? r.name} isn't stated` }
  }
  const shown = `${m.at_least ? '≥ ' : ''}${m.value}${m.unit ? ` ${m.unit}` : ''}`
  if (r.min !== undefined && m.value < r.min) return { verdict: 'no', detail: shown }
  // "N+" says only that the figure is at least N, so a ceiling can't be checked against it.
  if (r.max !== undefined) {
    if (m.value > r.max) return { verdict: 'no', detail: shown }
    if (m.at_least) return { verdict: 'unknown', detail: `${shown} (a lower bound)` }
  }
  return { verdict: 'match', detail: shown }
}

function matchRack(r: Extract<Requirement, { kind: 'rack' }>, d: Derived): Outcome {
  if (!d.known.rack) return { verdict: 'unknown', detail: "form factor isn't known" }
  if (!d.rack.mountable) return { verdict: 'no', detail: 'not rack-mountable' }
  if (d.rack.units === 0) return { verdict: 'unknown', detail: "rack height isn't stated" }
  if (r.maxUnits !== undefined && d.rack.units > r.maxUnits) return { verdict: 'no', detail: `${d.rack.units}U` }
  return { verdict: 'match', detail: `${d.rack.units}U` }
}

/** Judges one requirement against a product's derived specs. */
export function evaluate(r: Requirement, d: Derived): Outcome {
  switch (r.kind) {
    case 'port':
      return matchPorts(r, d)
    case 'radio':
      return matchRadio(r, d)
    case 'metric':
      return matchMetric(r, d)
    case 'rack':
      return matchRack(r, d)
  }
}

export interface Judgement {
  /** Every requirement matches. "no" if any doesn't; otherwise "unknown" if any can't be judged. */
  verdict: Verdict
  outcomes: Outcome[]
}

/** Judges a product against all the requirements. A product with no derived specs can't be judged. */
export function judge(reqs: Requirement[], d: Derived | null): Judgement {
  if (reqs.length === 0) return { verdict: 'match', outcomes: [] }
  if (!d) return { verdict: 'unknown', outcomes: reqs.map(() => ({ verdict: 'unknown' as const, detail: 'no specifications yet' })) }
  const outcomes = reqs.map((r) => evaluate(r, d))
  const verdict = outcomes.some((o) => o.verdict === 'no') ? 'no' : outcomes.some((o) => o.verdict === 'unknown') ? 'unknown' : 'match'
  return { verdict, outcomes }
}

// ---- Text form, for the URL ----

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * The compact text form used in the URL: a kind, then key=value pairs, joined
 * by ";" ("port;speed=10000;poe=PoE+++"). Round-trips through parseRequirement.
 */
export function serializeRequirement(r: Requirement): string {
  const parts: string[] = [r.kind]
  const add = (k: string, v: string | number | undefined) => {
    if (v !== undefined && v !== '') parts.push(`${k}=${v}`)
  }
  switch (r.kind) {
    case 'port':
      add('speed', r.minSpeedMbps)
      add('media', r.media)
      add('poe', r.poeClass)
      add('dir', r.poeDirection)
      add('count', r.minCount)
      break
    case 'radio':
      add('band', r.band)
      add('tx', r.minTxDbm)
      add('gain', r.minGainDbi)
      break
    case 'metric':
      add('name', r.name)
      add('min', r.min)
      add('max', r.max)
      break
    case 'rack':
      add('units', r.maxUnits)
      break
  }
  return parts.join(';')
}

/** Reads the text form; null for anything malformed or unknown, so a hand-edited URL can't break the page. */
export function parseRequirement(text: string): Requirement | null {
  const [kind, ...pairs] = text.split(';')
  const kv = new Map<string, string>()
  for (const pair of pairs) {
    const i = pair.indexOf('=')
    if (i < 1) return null
    kv.set(pair.slice(0, i), pair.slice(i + 1))
  }
  const allowed = (keys: string[]) => [...kv.keys()].every((k) => keys.includes(k))
  const badNumber = (k: string) => kv.has(k) && num(kv.get(k)) === undefined
  switch (kind) {
    case 'port': {
      if (!allowed(['speed', 'media', 'poe', 'dir', 'count']) || badNumber('speed') || badNumber('count')) return null
      const media = kv.get('media')
      const poe = kv.get('poe')
      const dir = kv.get('dir')
      if (media !== undefined && !(PORT_MEDIA as readonly string[]).includes(media)) return null
      if (poe !== undefined && poeRank(poe) === 0) return null
      if (dir !== undefined && dir !== 'out' && dir !== 'in') return null
      const count = num(kv.get('count'))
      if (count !== undefined && (count < 1 || !Number.isInteger(count))) return null
      return { kind, minSpeedMbps: num(kv.get('speed')), media, poeClass: poe, poeDirection: dir, minCount: count }
    }
    case 'radio': {
      const band = kv.get('band')
      if (!allowed(['band', 'tx', 'gain']) || badNumber('tx') || badNumber('gain')) return null
      if (band === undefined || !(BANDS as readonly string[]).includes(band)) return null
      return { kind, band, minTxDbm: num(kv.get('tx')), minGainDbi: num(kv.get('gain')) }
    }
    case 'metric': {
      const name = kv.get('name')
      if (!allowed(['name', 'min', 'max']) || badNumber('min') || badNumber('max')) return null
      if (name === undefined || !metricInfo(name)) return null
      const min = num(kv.get('min'))
      const max = num(kv.get('max'))
      if (min === undefined && max === undefined) return null
      return { kind, name, min, max }
    }
    case 'rack': {
      if (!allowed(['units']) || badNumber('units')) return null
      return { kind, maxUnits: num(kv.get('units')) }
    }
  }
  return null
}

/** Reads every well-formed requirement from the URL's list, skipping the rest. */
export function parseRequirements(texts: readonly string[] | undefined): Requirement[] {
  return (texts ?? []).map(parseRequirement).filter((r): r is Requirement => r !== null)
}

/** A readable phrase for a chip: "10 GbE+ port with PoE+++". */
export function describeRequirement(r: Requirement): string {
  switch (r.kind) {
    case 'port': {
      const speed = r.minSpeedMbps !== undefined ? `${formatSpeed(r.minSpeedMbps)}+ ` : ''
      const media = r.media ? `${r.media.toUpperCase()} ` : ''
      const count = r.minCount && r.minCount > 1 ? `${r.minCount}+ ` : 'a '
      const poe = r.poeClass ? ` with ${r.poeClass}${r.poeDirection ? ` ${r.poeDirection}` : ''}` : r.poeDirection ? ` with PoE ${r.poeDirection}` : ''
      return `${count}${speed}${media}port${r.minCount && r.minCount > 1 ? 's' : ''}${poe}`.replace(/^a (?=[aeiou])/i, 'an ')
    }
    case 'radio': {
      const extra = [r.minTxDbm !== undefined && `TX ≥ ${r.minTxDbm} dBm`, r.minGainDbi !== undefined && `gain ≥ ${r.minGainDbi} dBi`].filter(Boolean)
      return `${r.band} radio${extra.length ? ` (${extra.join(', ')})` : ''}`
    }
    case 'metric': {
      const info = metricInfo(r.name)
      const label = info?.label ?? r.name
      const unit = info?.unit ? ` ${info.unit}` : ''
      if (r.min !== undefined && r.max !== undefined) return `${label} ${r.min}–${r.max}${unit}`
      if (r.min !== undefined) return `${label} ≥ ${r.min}${unit}`
      return `${label} ≤ ${r.max}${unit}`
    }
    case 'rack':
      return r.maxUnits !== undefined ? `Rack-mount, ≤ ${r.maxUnits}U` : 'Rack-mount'
  }
}
