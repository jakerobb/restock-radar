import { driveOf, raidOptions, retentionDays } from './nvrStorage'

describe('driveOf', () => {
  it('reads the size of the store’s drives', () => {
    expect(driveOf('UACC-HDD-E-16TB')).toEqual({ kind: 'bay', tb: 16 })
    expect(driveOf('UACC-HDD-S-4TB')).toEqual({ kind: 'bay', tb: 4 })
    expect(driveOf('UACC-SSD-2.5-1TB')).toEqual({ kind: 'bay', tb: 1 })
    expect(driveOf('UACC-SSD-2TB')).toEqual({ kind: 'm2', tb: 2 })
    expect(driveOf('UACC-SSD-Tray')).toBeNull()
  })
})

describe('raidOptions', () => {
  const levels = (n: number, bays: number) => raidOptions(n, bays).map((o) => `${o.level}:${o.usable}`)
  it('follows UniFi’s rules for the number of drives', () => {
    expect(levels(0, 4)).toEqual([])
    expect(levels(1, 4)).toEqual([':1'])
    expect(levels(2, 4)).toEqual(['RAID 1:1'])
    expect(levels(3, 4)).toEqual(['RAID 5:2'])
    expect(levels(4, 4)).toEqual(['RAID 5:3', 'RAID 10:2'])
    expect(levels(5, 8)).toEqual(['RAID 5:4'])
    expect(levels(8, 8)).toEqual(['RAID 5:7', 'RAID 10:4'])
    expect(levels(9, 16)).toEqual(['RAID 5:8', 'RAID 6:7'])
    expect(levels(10, 16)).toEqual(['RAID 5:9', 'RAID 6:8', 'RAID 10:5'])
  })
})

describe('retentionDays', () => {
  it('is the storage over the rate', () => {
    expect(retentionDays(1, 100)).toBeCloseTo(0.926, 3)
    expect(retentionDays(1, 0)).toBe(Infinity)
  })
})
