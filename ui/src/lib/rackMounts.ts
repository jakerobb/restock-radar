/**
 * Rack-mount accessories and what each holds. The store doesn't say which products an accessory fits, or how
 * many, so it is stated here, by slug. Each takes `units` of rack space and holds up to `capacity` of the products.
 */
export interface RackMount {
  fits: readonly string[]
  capacity: number
  units: number
}

export const RACK_MOUNTS: Record<string, RackMount> = {
  'uacc-ai-port-rm': { fits: ['up-ai-port'], capacity: 6, units: 1 },
  'uacc-ai-key-rm': { fits: ['ai-key'], capacity: 3, units: 1 },
  'ckg2-rack-mount': { fits: ['uck-g2-ssd'], capacity: 1, units: 1 },
  'uacc-pro-max-16-rm': { fits: ['usw-pro-max-16', 'usw-pro-max-16-poe'], capacity: 1, units: 1 },
  'uacc-ucg-industrial-rm': { fits: ['ucg-industrial'], capacity: 1, units: 1 },
}

/** Products that go in a rack only with one of those (the store lists some as rack-mount, some as desktop, some both). */
export const NEEDS_RACK_MOUNT: ReadonlySet<string> = new Set(Object.values(RACK_MOUNTS).flatMap((m) => m.fits))

/** Rack equipment whose height the store doesn't state (it has no form factor), by slug. */
export const RACK_UNITS: Record<string, number> = {
  'usp-pdu-pro': 2,
  'uacc-rack-panel-patch-blank-24': 1,
}
