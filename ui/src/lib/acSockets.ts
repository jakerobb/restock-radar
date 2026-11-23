import { baseSlug } from './convertPlan'

/**
 * Equipment that gives AC sockets to the plan instead of only taking an outlet, by slug without its region. The store
 * doesn't say how many sockets a PDU or UPS has, so it is stated here. A PDU is fed from a UPS socket when there is
 * one; a UPS is always fed from a wall outlet.
 */
export interface AcSockets {
  kind: 'pdu' | 'ups'
  sockets: number
  /** Whether it goes in a rack, which the store doesn't always say. */
  rack: boolean
}

export const AC_SOCKETS: Record<string, AcSockets> = {
  'usp-pdu-pro': { kind: 'pdu', sockets: 16, rack: true },
  'usp-pdu-hd': { kind: 'pdu', sockets: 24, rack: true },
  'ups-tower': { kind: 'ups', sockets: 8, rack: false },
  'ups-2u': { kind: 'ups', sockets: 8, rack: true },
  'ups-2u-pro': { kind: 'ups', sockets: 8, rack: true },
}

/** The AC sockets a product with this slug provides; undefined for one that isn't a PDU or UPS. */
export const acSocketsOf = (slug: string): AcSockets | undefined => AC_SOCKETS[baseSlug(slug)]
