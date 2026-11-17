import { powerLabel, powerSummary } from './power'
import type { PowerSource } from '../api/types'

const src = (kind: PowerSource['kind'], poe_class = ''): PowerSource => ({ kind, poe_class, detail: '' })

describe('powerSummary', () => {
  it('names each way, PoE by its class, in the order given', () => {
    expect(powerSummary([src('poe', 'PoE++'), src('passive_poe'), src('ac'), src('rps'), src('dc'), src('usb'), src('battery'), src('other')])).toBe('PoE++, Passive PoE, AC, RPS, DC, USB, Battery, Other')
  })

  it('is null when nothing is stated, so a table shows it as unknown rather than as “none”', () => {
    expect(powerSummary([])).toBeNull()
    expect(powerSummary(undefined)).toBeNull()
  })

  it('says plain PoE when the class is missing, and passes an unknown kind through', () => {
    expect(powerLabel(src('poe'))).toBe('PoE')
    expect(powerLabel({ kind: 'fusion' as PowerSource['kind'], poe_class: '', detail: '' })).toBe('fusion')
  })
})
