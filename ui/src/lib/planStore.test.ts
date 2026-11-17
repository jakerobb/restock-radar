import { getPlan, resetPlanStore, setPlan, subscribePlan } from './planStore'
import { serializeLine } from './plan'

const l = { ref: 'us/a', sku: 'S', qty: 2, addedCents: 100 }

describe('planStore', () => {
  it('keeps the plan across a reload of the page', () => {
    setPlan([l])
    resetPlanStore() // as if the page were opened afresh
    expect(getPlan()).toEqual([l])
  })

  it('hands out the same array until the plan changes', () => {
    expect(getPlan()).toBe(getPlan())
    const before = getPlan()
    setPlan([l])
    expect(getPlan()).not.toBe(before)
  })

  it('starts empty when what is stored is damaged', () => {
    localStorage.setItem('restock-radar.plan', '{not json')
    expect(getPlan()).toEqual([])
    resetPlanStore()
    localStorage.setItem('restock-radar.plan', JSON.stringify(['junk', serializeLine(l)]))
    expect(getPlan()).toEqual([l])
  })

  it('still works, in memory, when the browser won’t store anything', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(getPlan()).toEqual([])
    setPlan([l])
    expect(getPlan()).toEqual([l])
    get.mockRestore()
    set.mockRestore()
  })

  it('tells listeners about a change here and one from another tab, and stops when they leave', () => {
    const seen = vi.fn()
    const off = subscribePlan(seen)
    setPlan([l])
    expect(seen).toHaveBeenCalledTimes(1)
    localStorage.setItem('restock-radar.plan', JSON.stringify([serializeLine({ ...l, qty: 5 })]))
    window.dispatchEvent(new StorageEvent('storage', { key: 'restock-radar.plan' }))
    expect(seen).toHaveBeenCalledTimes(2)
    expect(getPlan()[0]!.qty).toBe(5)
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }))
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    setPlan([])
    expect(seen).toHaveBeenCalledTimes(2)
  })
})
