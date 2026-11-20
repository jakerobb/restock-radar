import { inRegion, pickRegion, regionForLanguage, regionName } from './region'

describe('regionForLanguage', () => {
  it.each([
    ['en-US', 'us'],
    ['en-GB', 'uk'],
    ['en-CA', 'ca'],
    ['fr-CA', 'ca'],
    ['de-DE', 'eu'],
    ['fr-FR', 'eu'],
    ['es-ES', 'eu'],
    ['pt-PT', 'eu'],
    ['pt-BR', 'br'],
    ['ja-JP', 'jp'],
    ['zh-TW', 'tw'],
    ['en-SG', 'sg'],
    ['zh-Hant-TW', 'tw'],
    ['ja', 'jp'],
    ['pt', 'br'],
    ['zh-Hant', 'tw'],
  ])('%s is %s', (tag, want) => expect(regionForLanguage(tag)).toBe(want))

  it.each(['en', 'fr', 'de', 'zh-CN', 'es-MX', 'en-AU', ''])('has nothing to say about %j', (tag) => expect(regionForLanguage(tag)).toBeUndefined())
})

describe('pickRegion', () => {
  const all = ['us', 'ca', 'eu', 'uk', 'jp']
  it('keeps a choice that is still available', () => expect(pickRegion(all, 'jp', ['en-GB'])).toBe('jp'))
  it('ignores a choice that no longer is', () => expect(pickRegion(['us', 'uk'], 'jp', ['en-GB'])).toBe('uk'))
  it('follows the first language that points at an available region', () => expect(pickRegion(all, null, ['en', 'de-AT', 'en-GB'])).toBe('eu'))
  it('skips a language whose region is not tracked', () => expect(pickRegion(['us', 'uk'], null, ['ja-JP', 'en-GB'])).toBe('uk'))
  it('falls back to the US, else the first', () => {
    expect(pickRegion(all, null, ['en-AU'])).toBe('us')
    expect(pickRegion(['eu', 'uk'], null, ['en-AU'])).toBe('eu')
    expect(pickRegion([], null, [])).toBe('us')
  })
})

describe('region helpers', () => {
  it('names regions, and a stranger by its id', () => {
    expect(regionName('uk')).toBe('United Kingdom')
    expect(regionName('xx')).toBe('XX')
  })
  it('keeps what is in a region', () => {
    expect(inRegion([{ region: 'us' }, { region: 'eu' }, { region: 'us' }], 'us')).toHaveLength(2)
  })
})
