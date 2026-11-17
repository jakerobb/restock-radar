import type { Requirement } from './requirements'
import { describeRequirement, evaluate, judge, parseRequirement, parseRequirements, serializeRequirement } from './requirements'
import { derived, port } from '../test/fixtures'

const known = { ports: true, poe: true, radios: true, rack: true, dims: true }

describe('port requirements', () => {
  const tenGigPoE = port({ label: '10 GbE RJ45', count: 2, max_speed_mbps: 10000, poe_class: 'PoE+++', poe_direction: 'out' })
  const d = derived({ known, ports: [port({ count: 24 }), tenGigPoE, port({ label: 'SFP+', media: 'sfp+', count: 2, max_speed_mbps: 10000 })] })

  it('matches a port of at least the speed and PoE class, and says which', () => {
    const o = evaluate({ kind: 'port', minSpeedMbps: 10000, poeClass: 'PoE+++' }, d)
    expect(o.verdict).toBe('match')
    expect(o.detail).toBe('2 × 10 GbE RJ45 (PoE+++ out)')
  })

  it('takes a higher PoE class as satisfying a lower one', () => {
    expect(evaluate({ kind: 'port', poeClass: 'PoE+' }, d).verdict).toBe('match')
    expect(evaluate({ kind: 'port', poeClass: 'PoE++' }, derived({ known, ports: [port({ poe_class: 'PoE+', poe_direction: 'out' })] })).verdict).toBe('no')
  })

  it('counts ports across entries and compares with the count asked for', () => {
    expect(evaluate({ kind: 'port', minSpeedMbps: 10000, minCount: 4 }, d).verdict).toBe('match') // 2 RJ45 + 2 SFP+
    expect(evaluate({ kind: 'port', minSpeedMbps: 10000, minCount: 5 }, d).verdict).toBe('no')
  })

  it('filters by media', () => {
    expect(evaluate({ kind: 'port', media: 'sfp+', minCount: 2 }, d).verdict).toBe('match')
    expect(evaluate({ kind: 'port', media: 'sfp28' }, d).verdict).toBe('no')
  })

  it('distinguishes PoE in from PoE out', () => {
    const powered = derived({ known, ports: [port({ poe_class: 'PoE++', poe_direction: 'in' })] })
    expect(evaluate({ kind: 'port', poeClass: 'PoE', poeDirection: 'out' }, powered).verdict).toBe('no')
    expect(evaluate({ kind: 'port', poeClass: 'PoE', poeDirection: 'in' }, powered).verdict).toBe('match')
  })

  it("is unknown, not no, when the ports aren't known", () => {
    expect(evaluate({ kind: 'port', minSpeedMbps: 1000 }, derived()).verdict).toBe('unknown')
  })

  it("is unknown when a port's speed isn't stated and it could satisfy the requirement", () => {
    const d2 = derived({ known, ports: [port({ max_speed_mbps: 0, speeds_mbps: [], count: 1 })] })
    expect(evaluate({ kind: 'port', minSpeedMbps: 10000 }, d2).verdict).toBe('unknown')
    // ...but a port that is certainly too slow is a no.
    expect(evaluate({ kind: 'port', minSpeedMbps: 10000 }, derived({ known, ports: [port()] })).verdict).toBe('no')
  })

  it('does not take a port with no PoE as a maybe when a direction was asked for', () => {
    const d2 = derived({ known, ports: [port({ count: 8 })] })
    expect(evaluate({ kind: 'port', poeDirection: 'out' }, d2).verdict).toBe('no')
  })

  it("is unknown when a PoE port's direction isn't stated and one was asked for", () => {
    const d2 = derived({ known, ports: [port({ poe_class: 'PoE+', poe_direction: '' })] })
    expect(evaluate({ kind: 'port', poeClass: 'PoE+', poeDirection: 'out' }, d2).verdict).toBe('unknown')
  })

  it("doesn't count console or management ports as data ports", () => {
    const d2 = derived({ known, ports: [port({ role: 'console', max_speed_mbps: 10000, count: 1 })] })
    expect(evaluate({ kind: 'port', minSpeedMbps: 10000 }, d2).verdict).toBe('no')
  })
})

describe('radio requirements', () => {
  const radio = (o = {}) => ({ band: '6 GHz', tech: 'wifi', antenna_gain_dbi: 5, tx_power_dbm: 23, streams: 2, max_rate_mbps: 4800, ...o })

  it('matches a radio in the band and reports its figures', () => {
    const d = derived({ known, radios: [radio()] })
    expect(evaluate({ kind: 'radio', band: '6 GHz' }, d)).toEqual({ verdict: 'match', detail: '6 GHz radio (23 dBm, 5 dBi)' })
  })

  it('applies TX power and gain floors', () => {
    const d = derived({ known, radios: [radio()] })
    expect(evaluate({ kind: 'radio', band: '6 GHz', minTxDbm: 24 }, d).verdict).toBe('no')
    expect(evaluate({ kind: 'radio', band: '6 GHz', minGainDbi: 6 }, d).verdict).toBe('no')
    expect(evaluate({ kind: 'radio', band: '6 GHz', minTxDbm: 20, minGainDbi: 5 }, d).verdict).toBe('match')
  })

  it("is unknown when the radio is there but its figure isn't stated", () => {
    const d = derived({ known, radios: [radio({ tx_power_dbm: null })] })
    expect(evaluate({ kind: 'radio', band: '6 GHz', minTxDbm: 20 }, d).verdict).toBe('unknown')
  })

  it('is no when there is no radio in that band, and unknown when radios are not known', () => {
    expect(evaluate({ kind: 'radio', band: '6 GHz' }, derived({ known, radios: [radio({ band: '5 GHz' })] })).verdict).toBe('no')
    expect(evaluate({ kind: 'radio', band: '6 GHz' }, derived()).verdict).toBe('unknown')
  })
})

describe('metric requirements', () => {
  const m = (name: string, value: number, extra = {}) => ({ name, value, unit: 'W', at_least: false, raw: '', ...extra })

  it('compares against a minimum and a maximum', () => {
    const d = derived({ known, metrics: [m('poe_budget_w', 200)] })
    expect(evaluate({ kind: 'metric', name: 'poe_budget_w', min: 200 }, d).verdict).toBe('match')
    expect(evaluate({ kind: 'metric', name: 'poe_budget_w', min: 201 }, d).verdict).toBe('no')
    expect(evaluate({ kind: 'metric', name: 'poe_budget_w', max: 199 }, d).verdict).toBe('no')
    expect(evaluate({ kind: 'metric', name: 'poe_budget_w', min: 100, max: 300 }, d).verdict).toBe('match')
  })

  it('can say a published "N+" figure meets a minimum but cannot say it is under a maximum', () => {
    const d = derived({ known, metrics: [m('ids_ips_throughput_mbps', 8000, { at_least: true, unit: 'Mbps' })] })
    expect(evaluate({ kind: 'metric', name: 'ids_ips_throughput_mbps', min: 5000 }, d).verdict).toBe('match')
    expect(evaluate({ kind: 'metric', name: 'ids_ips_throughput_mbps', max: 9000 }, d).verdict).toBe('unknown')
    expect(evaluate({ kind: 'metric', name: 'ids_ips_throughput_mbps', max: 7000 }, d).verdict).toBe('no')
  })

  it('is unknown when the figure is absent, except a product with known PoE facts and no budget', () => {
    expect(evaluate({ kind: 'metric', name: 'switching_capacity_gbps', min: 1 }, derived({ known })).verdict).toBe('unknown')
    expect(evaluate({ kind: 'metric', name: 'poe_budget_w', min: 1 }, derived({ known })).verdict).toBe('no')
    expect(evaluate({ kind: 'metric', name: 'poe_budget_w', min: 1 }, derived()).verdict).toBe('unknown')
  })
})

describe('rack requirements', () => {
  it('matches a rack-mount device within the height', () => {
    const d = derived({ known, rack: { mountable: true, units: 1, full_depth: false } })
    expect(evaluate({ kind: 'rack', maxUnits: 1 }, d)).toEqual({ verdict: 'match', detail: '1U' })
    expect(evaluate({ kind: 'rack', maxUnits: 1 }, derived({ known, rack: { mountable: true, units: 2, full_depth: false } })).verdict).toBe('no')
  })

  it('is no for a device that is not rack-mountable, and unknown when the form factor is not known', () => {
    expect(evaluate({ kind: 'rack' }, derived({ known })).verdict).toBe('no')
    expect(evaluate({ kind: 'rack' }, derived()).verdict).toBe('unknown')
    expect(evaluate({ kind: 'rack', maxUnits: 1 }, derived({ known, rack: { mountable: true, units: 0, full_depth: false } })).verdict).toBe('unknown')
  })
})

describe('judge', () => {
  const reqs: Requirement[] = [{ kind: 'port', minSpeedMbps: 10000 }, { kind: 'rack' }]

  it('is a match only when every requirement matches', () => {
    const d = derived({ known, ports: [port({ max_speed_mbps: 10000 })], rack: { mountable: true, units: 1, full_depth: false } })
    expect(judge(reqs, d).verdict).toBe('match')
  })

  it('is no if any requirement is a no, even when another is unknown', () => {
    expect(judge(reqs, derived({ known: { ...known, rack: false }, ports: [port()] })).verdict).toBe('no')
  })

  it("is unknown when nothing is a no but something can't be judged", () => {
    expect(judge(reqs, derived({ known: { ...known, rack: false }, ports: [port({ max_speed_mbps: 10000 })] })).verdict).toBe('unknown')
  })

  it('treats no requirements as a match, and a product without specs as unknown', () => {
    expect(judge([], null).verdict).toBe('match')
    const j = judge(reqs, null)
    expect(j.verdict).toBe('unknown')
    expect(j.outcomes).toHaveLength(2)
  })
})

describe('the URL form', () => {
  const samples: Requirement[] = [
    { kind: 'port', minSpeedMbps: 10000, poeClass: 'PoE+++', poeDirection: 'out', media: 'rj45', minCount: 2 },
    { kind: 'port' },
    { kind: 'radio', band: '6 GHz', minTxDbm: 23, minGainDbi: 4.5 },
    { kind: 'metric', name: 'poe_budget_w', min: 200 },
    { kind: 'metric', name: 'power_draw_max_w', max: 30 },
    { kind: 'rack', maxUnits: 1 },
    { kind: 'rack' },
  ]

  it.each(samples)('round-trips %j', (r) => {
    const text = serializeRequirement(r)
    expect(parseRequirement(text)).toEqual(expect.objectContaining(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined))))
    expect(serializeRequirement(parseRequirement(text)!)).toBe(text)
  })

  it('reads the compact form', () => {
    expect(serializeRequirement({ kind: 'port', minSpeedMbps: 10000, poeClass: 'PoE+++' })).toBe('port;speed=10000;poe=PoE+++')
  })

  it.each([
    '',
    'nonsense',
    'port;speed=fast',
    'port;speed=-1',
    'port;speed=Infinity',
    'port;media=floppy',
    'port;poe=PoE++++',
    'port;dir=sideways',
    'port;count=0',
    'port;count=1.5',
    'port;color=red',
    'port;=1',
    'radio',
    'radio;band=7 GHz',
    'radio;band=6 GHz;tx=abc',
    'metric;name=nope;min=1',
    'metric;name=poe_budget_w',
    'metric;name=poe_budget_w;min=x',
    'rack;units=-2',
    'rack;depth=1',
  ])('rejects %j', (text) => {
    expect(parseRequirement(text)).toBeNull()
  })

  it('skips malformed entries but keeps the good ones', () => {
    expect(parseRequirements(['rack', 'bogus', 'radio;band=6 GHz'])).toHaveLength(2)
    expect(parseRequirements(undefined)).toEqual([])
  })
})

describe('describeRequirement', () => {
  it.each<[Requirement, string]>([
    [{ kind: 'port', minSpeedMbps: 10000, poeClass: 'PoE+++' }, 'a 10 GbE+ port with PoE+++'],
    [{ kind: 'port', minSpeedMbps: 2500, minCount: 4, media: 'rj45', poeClass: 'PoE+', poeDirection: 'out' }, '4+ 2.5 GbE+ RJ45 ports with PoE+ out'],
    [{ kind: 'radio', band: '6 GHz', minTxDbm: 20 }, '6 GHz radio (TX ≥ 20 dBm)'],
    [{ kind: 'metric', name: 'poe_budget_w', min: 200 }, 'PoE budget ≥ 200 W'],
    [{ kind: 'metric', name: 'power_draw_max_w', max: 30 }, 'Max power draw ≤ 30 W'],
    [{ kind: 'rack', maxUnits: 1 }, 'Rack-mount, ≤ 1U'],
  ])('%j -> %s', (r, text) => {
    expect(describeRequirement(r)).toBe(text)
  })
})
