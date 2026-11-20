import type { Derived } from '../api/types'

/**
 * True when a product is a PoE injector (a "PoE adapter"): a mains-powered box that takes data in on one port and gives
 * data and PoE out on the other. The store doesn't describe its ports, so the derivation reads them from its output
 * rating and name (see injector.go); it is then a one-port PoE supplier, with a budget of its own, that has to be plugged
 * into a switch port like any device.
 */
export const isInjector = (d: Derived | null | undefined): boolean => !!d?.known.ports && d.ports.some((p) => p.source === 'injector')
