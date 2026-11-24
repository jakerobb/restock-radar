import { dominantRegion, planRegionState } from './regionMismatch'

describe('dominantRegion', () => {
  it('is the region most lines are in', () => {
    expect(dominantRegion(['us/a', 'eu/b', 'eu/c'], 'us')).toBe('eu')
  })
  it('breaks a tie towards the picked region, else the first seen', () => {
    expect(dominantRegion(['us/a', 'eu/b'], 'eu')).toBe('eu')
    expect(dominantRegion(['us/a', 'eu/b'], 'jp')).toBe('us')
  })
  it('is nothing for an empty plan', () => {
    expect(dominantRegion([], 'us')).toBeUndefined()
  })
})

describe('planRegionState', () => {
  it('tells apart empty, matching, elsewhere and mixed', () => {
    expect(planRegionState([], 'us')).toEqual({ kind: 'none' })
    expect(planRegionState(['us/a', 'us/b'], 'us')).toEqual({ kind: 'match', region: 'us' })
    expect(planRegionState(['eu/a'], 'us')).toEqual({ kind: 'elsewhere', region: 'eu' })
    expect(planRegionState(['us/a', 'us/b', 'eu/c'], 'us')).toEqual({ kind: 'mixed', region: 'us', counts: [{ region: 'us', count: 2 }, { region: 'eu', count: 1 }] })
  })
})
