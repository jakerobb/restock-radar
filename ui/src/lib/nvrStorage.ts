import type { Derived } from '../api/types'

/** The drive sizes (TB) the plan offers an NVR's bays: what the store sells, less the 8 TB one. */
export const DRIVE_SIZES_TB: readonly number[] = [1, 4, 16, 24]

/**
 * What a storage product is, from its SKU: a drive for the bays of an NVR ("UACC-HDD-E-16TB", the 2.5" SSD), or an
 * M.2 SSD for the slot of a gateway ("UACC-SSD-2TB"); null for anything else.
 */
export function driveOf(sku: string): { kind: 'bay' | 'm2'; tb: number } | null {
  const m = /^UACC-(HDD|SSD)-(?:[A-Z]-|2\.5-)?(\d+)TB$/i.exec(sku)
  if (!m) return null
  return { kind: m[1]!.toUpperCase() === 'HDD' || /2\.5/.test(sku) ? 'bay' : 'm2', tb: Number(m[2]) }
}

/** How many drive bays a product has, 0 when it has none (or isn't an NVR). */
export function driveBays(d: Derived | null): number {
  const v = d?.metrics.find((m) => m.name === 'nvr_drive_bays')?.value
  return typeof v === 'number' && v > 0 ? v : 0
}

/** The storage an NVR has that can't be changed (a microSD card, the CloudKey+'s SSD), in TB; 0 when none. */
export function fixedStorageTb(d: Derived | null): number {
  const v = d?.metrics.find((m) => m.name === 'nvr_storage_tb')?.value
  return typeof v === 'number' && v > 0 ? v : 0
}

/** One way to protect a set of drives, and how many drives' worth of data it leaves room for. */
export interface RaidOption {
  /** "RAID 5". Empty for storage that isn't an array (one drive, a card). */
  level: string
  /** Drives' worth of effective storage. */
  usable: number
}

/**
 * The RAID levels a UniFi NVR offers for a number of drives (help.ui.com, "Storage Protection and Data Redundancy
 * in UniFi (RAID)"): two drives are always mirrored, three or more are RAID 5, RAID 6 comes with nine or more (the
 * ENVR, the only one with so many bays), and RAID 10 with an even number of at least four. Drives of different
 * sizes count at the smallest, so a size is all it takes.
 */
export function raidOptions(drives: number, bays: number): RaidOption[] {
  if (drives < 1) return []
  if (drives === 1) return [{ level: '', usable: 1 }]
  if (drives === 2) return [{ level: 'RAID 1', usable: 1 }]
  const out: RaidOption[] = [{ level: 'RAID 5', usable: drives - 1 }]
  if (drives >= 9 && bays >= 9) out.push({ level: 'RAID 6', usable: drives - 2 })
  if (drives >= 4 && drives % 2 === 0) out.push({ level: 'RAID 10', usable: drives / 2 })
  return out
}

/** How long TB of storage lasts recording at a total of mbps (decimal TB, as drives are sold); Infinity when nothing records. */
export const retentionDays = (tb: number, mbps: number): number => (mbps > 0 ? (tb * 8e6) / (mbps * 86400) : Infinity)

/** A storage size as text: "48 TB", "0.5 TB", "128 GB" below a tenth. */
export const formatTb = (tb: number): string => (tb < 0.1 ? `${Math.round(tb * 1000)} GB` : `${Math.round(tb * 100) / 100} TB`)
