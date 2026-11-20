import { createPlan, deletePlan, nameTaken, uniqueName, getActiveId, getPlan, getPlanName, getPlans, renamePlan, resetPlanStore, selectPlan, setPlan, subscribePlan } from './planStore'
import { serializeLine } from './plan'

const KEY = 'restock-radar.plans'
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
    localStorage.setItem(KEY, '{not json')
    expect(getPlan()).toEqual([])
    resetPlanStore()
    localStorage.setItem(KEY, JSON.stringify({ active: 'a', plans: [{ id: 'a', name: 'X', lines: ['junk', serializeLine(l)] }] }))
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
    localStorage.setItem(KEY, JSON.stringify({ active: 'a', plans: [{ id: 'a', name: 'X', lines: [serializeLine({ ...l, qty: 5 })] }] }))
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
    expect(seen).toHaveBeenCalledTimes(2)
    expect(getPlan()[0]!.qty).toBe(5)
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }))
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    setPlan([])
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('starts with one plan, called My Plan', () => {
    expect(getPlans()).toHaveLength(1)
    expect(getPlanName()).toBe('My Plan')
  })

  it('renames the plan, tidying the name and keeping it to 50 characters', () => {
    renamePlan('  Garage   rack ')
    expect(getPlanName()).toBe('Garage rack')
    renamePlan('x'.repeat(80))
    expect(getPlanName()).toBe('x'.repeat(50))
    renamePlan('   ')
    expect(getPlanName()).toBe('x'.repeat(50))
  })

  it('keeps plans apart, switching to a new one and back', () => {
    setPlan([l])
    const first = getActiveId()
    createPlan('Second')
    expect(getPlan()).toEqual([])
    expect(getPlanName()).toBe('Second')
    selectPlan(first)
    expect(getPlan()).toEqual([l])
    resetPlanStore()
    expect(getPlans().map((p) => p.name)).toEqual(['My Plan', 'Second'])
    expect(getActiveId()).toBe(first)
  })

  it('deletes the plan being edited, and empties the last one instead', () => {
    const first = getActiveId()
    createPlan('Second', [l])
    deletePlan()
    expect(getActiveId()).toBe(first)
    expect(getPlans()).toHaveLength(1)
    setPlan([l])
    renamePlan('Mine')
    deletePlan()
    expect(getPlans()).toHaveLength(1)
    expect(getPlan()).toEqual([])
    expect(getPlanName()).toBe('My Plan')
  })

  it('won’t give two plans the same name, however it is capitalised', () => {
    createPlan('Garage')
    expect(createPlan('garage ')).toBeNull()
    expect(getPlans()).toHaveLength(2)
    expect(renamePlan('MY PLAN')).toBe(false)
    expect(getPlanName()).toBe('Garage')
    expect(renamePlan('GARAGE')).toBe(true) // its own name, in other capitals
    expect(nameTaken(getPlans(), 'my plan')).toBe(true)
  })

  it('finds a free name by numbering, within 50 characters', () => {
    createPlan('Garage')
    createPlan('Garage (2)')
    expect(uniqueName(getPlans(), 'Garage')).toBe('Garage (3)')
    expect(uniqueName(getPlans(), 'Shop')).toBe('Shop')
    createPlan('x'.repeat(50))
    expect(uniqueName(getPlans(), 'x'.repeat(50))).toBe('x'.repeat(46) + ' (2)')
  })

  it('numbers duplicates it finds in storage', () => {
    localStorage.setItem(KEY, JSON.stringify({ active: 'a', plans: [{ id: 'a', name: 'Same', lines: [] }, { id: 'b', name: 'same', lines: [] }] }))
    expect(getPlans().map((p) => p.name)).toEqual(['Same', 'same (2)'])
  })
})
