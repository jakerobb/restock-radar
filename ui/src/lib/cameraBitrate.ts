import type { Derived } from '../api/types'
import { cameraClass, type CameraClass } from './nvrChecks'

/**
 * What a camera records at, in Mbps, continuously and encoded as H.264. These are guesses by resolution class (one
 * sensor), to be tuned against UniFi's capacity calculator: what a camera really records at depends on its scene,
 * its frame rate and its quality setting.
 */
export const CLASS_MBPS: Record<CameraClass, number> = { hd: 3, '2k': 6, '4k': 12 }

const metric = (d: Derived | null, n: string): number | null => {
  const v = d?.metrics.find((m) => m.name === n)?.value
  return typeof v === 'number' && v > 0 ? v : null
}

/** Megapixels a "4K" sensor has, the size the 4K class rate is for. */
const SENSOR_4K_MP = 8.3

/**
 * A camera's bitrate in Mbps, null when its resolution isn't known. It is the class rate for its sensor's resolution
 * (more than 4K's 8.3 MP scales it up) times the number of sensors, each of which is a stream. A bitrate stated for
 * the camera itself (the `camera_bitrate_mbps` metric, which a spec override can add) is used as it stands.
 */
export function cameraMbps(d: Derived | null): number | null {
  const stated = metric(d, 'camera_bitrate_mbps')
  if (stated !== null) return stated
  const mp = metric(d, 'camera_megapixels')
  if (mp === null) return null
  const sensors = metric(d, 'camera_sensors') ?? 1
  return CLASS_MBPS[cameraClass(mp)] * Math.max(1, mp / SENSOR_4K_MP) * sensors
}
