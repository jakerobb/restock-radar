import type { Derived } from '../api/types'
import type { DerivedLine, PlanCheck } from './planChecks'

/** The resolution classes an NVR states its camera capacity in. */
export type CameraClass = 'hd' | '2k' | '4k'
export const CAMERA_CLASSES: readonly CameraClass[] = ['4k', '2k', 'hd']
export const CLASS_LABEL: Record<CameraClass, string> = { hd: 'HD', '2k': '2K', '4k': '4K' }

/** Store categories that hold cameras (and doorbells), as opposed to recorders, sensors and accessories. */
const CAMERA_CATEGORIES = new Set(['physical-security-bullet', 'physical-security-compact', 'physical-security-dome-turret', 'physical-security-doorbells', 'physical-security-ptz'])

const metric = (d: Derived | null, n: string): number | null => {
  const v = d?.metrics.find((m) => m.name === n)?.value
  return typeof v === 'number' && v > 0 ? v : null
}

/** How many cameras of each class an NVR manages, as it states them; a class it doesn't state is missing. */
export function nvrCapacity(d: Derived | null): Partial<Record<CameraClass, number>> {
  const out: Partial<Record<CameraClass, number>> = {}
  for (const c of CAMERA_CLASSES) {
    const n = metric(d, `nvr_cameras_${c}`)
    if (n !== null) out[c] = n
  }
  return out
}

export const isNvr = (d: Derived | null): boolean => Object.keys(nvrCapacity(d)).length > 0

/** Maps a sensor's megapixels to the class the NVRs count it in (up to HD's 2 MP, 2K's 4 MP, else 4K; a 5 MP camera counts as 4K, the safe side). */
export function cameraClass(megapixels: number): CameraClass {
  if (megapixels <= 2.2) return 'hd'
  if (megapixels <= 4.2) return '2k'
  return '4k'
}

/** Whether a line is a camera: its class when its resolution is known, null when it is a camera of unknown resolution, undefined when it isn't a camera. */
export function cameraOf(l: DerivedLine): CameraClass | null | undefined {
  if (isNvr(l.derived) || !CAMERA_CATEGORIES.has(l.view.product?.category ?? '')) return undefined
  const mp = metric(l.derived, 'camera_megapixels')
  return mp === null ? null : cameraClass(mp)
}

export interface NvrStats {
  /** Cameras no NVR has room for. */
  unplaced: number
  /** Capacity left across the NVRs, in whole NVRs' worth (0.45 is 45% of one). */
  spare: number
}

const pct = (f: number) => `${Math.round(f * 100)}%`
const EPS = 1e-9

interface Unit {
  line: DerivedLine
  caps: Partial<Record<CameraClass, number>>
  used: number
  counts: Record<CameraClass, number>
}

/**
 * Whether the plan's NVRs can manage its cameras. Each camera takes 1/capacity of an NVR for its class
 * ("(60) HD, (30) 2K, (18) 4K": a 4K camera is 1/18 of a UNVR, a 2K one 1/30), which is a rough, linear
 * estimate. Cameras are placed biggest first on the NVR with the most room.
 */
export function nvrCheck(lines: DerivedLine[]): PlanCheck[] {
  const counts: Record<CameraClass, number> = { hd: 0, '2k': 0, '4k': 0 }
  let unknown = 0
  for (const l of lines) {
    const c = cameraOf(l)
    if (c === undefined) continue
    if (c === null) unknown += l.view.line.qty
    else counts[c] += l.view.line.qty
  }
  const known = counts.hd + counts['2k'] + counts['4k']
  const cameras = known + unknown
  if (cameras === 0) return []
  const s = (n: number) => (n === 1 ? '' : 's')

  const units: Unit[] = lines.filter((l) => isNvr(l.derived)).flatMap((l) => Array.from({ length: l.view.line.qty }, () => ({ line: l, caps: nvrCapacity(l.derived), used: 0, counts: { hd: 0, '2k': 0, '4k': 0 } })))
  if (units.length === 0) {
    return [{ id: 'nvr', label: 'NVR', verdict: 'warn', nvrShortfall: true, text: `${cameras} camera${s(cameras)} in the plan, and no NVR to record ${cameras === 1 ? 'it' : 'them'}.` }]
  }

  // An NVR that can't be bought now gives no capacity to count on.
  const unavailable = lines.filter((l) => isNvr(l.derived) && l.view.state !== 'in')
  const stock: PlanCheck[] = unavailable.length === 0 ? [] : [{
    id: 'nvr-stock',
    label: 'NVR stock',
    verdict: 'warn',
    nvrShortfall: true,
    text: `${unavailable.map((l) => l.view.product?.title ?? l.view.line.ref).join(', ')} ${unavailable.length === 1 && unavailable[0]!.view.line.qty === 1 ? "isn't" : "aren't"} in stock, so the camera capacity ${unavailable.length === 1 ? 'it gives' : 'they give'} can't be had now.`,
  }]

  let unplaced = 0
  for (const c of CAMERA_CLASSES) {
    for (let i = 0; i < counts[c]; i++) {
      const fit = units.filter((u) => u.caps[c] !== undefined && u.used + 1 / u.caps[c]! <= 1 + EPS).sort((a, b) => a.used - b.used)[0]
      if (!fit) {
        unplaced++
        continue
      }
      fit.used += 1 / fit.caps[c]!
      fit.counts[c]++
    }
  }
  const spare = units.reduce((n, u) => n + Math.max(0, 1 - u.used), 0)
  const stats: NvrStats = { unplaced, spare }
  const many = units.length > 1
  const detail = units.map((u, i) => {
    const mix = CAMERA_CLASSES.filter((c) => u.counts[c] > 0).map((c) => `${u.counts[c]} × ${CLASS_LABEL[c]}`)
    return {
      title: `${u.line.view.product?.title ?? u.line.view.line.ref}${many ? ` (${i + 1} of ${units.length})` : ''}`,
      rows: [mix.length > 0 ? `${mix.join(', ')}: ${pct(u.used)} of its camera capacity used, ${pct(Math.max(0, 1 - u.used))} left` : 'No cameras on it'],
    }
  })

  if (unplaced > 0) {
    return [...stock, { id: 'nvr', label: 'NVR', verdict: 'bad', nvrShortfall: true, nvr: stats, detail, text: `${unplaced} of ${cameras} cameras have no room on the plan's ${many ? 'NVRs' : 'NVR'}.` }]
  }
  const used = units.length - spare
  const text = `${cameras} camera${s(cameras)} use${cameras === 1 ? 's' : ''} ${pct(used / units.length)} of the NVR${many ? 's’ combined' : '’s'} capacity.`
  if (unknown > 0) {
    return [...stock, { id: 'nvr', label: 'NVR', verdict: 'unknown', nvr: stats, detail, text: `Can't tell for ${unknown} camera${s(unknown)} whose resolution isn't known. The other ${known} use ${pct(used / units.length)} of the NVR${many ? 's’ combined' : '’s'} capacity.` }]
  }
  return [...stock, { id: 'nvr', label: 'NVR', verdict: 'ok', nvr: stats, detail, text }]
}
