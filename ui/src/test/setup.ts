import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { resetRegionChoice } from '../hooks/useRegion'
import { resetPlanStore } from '../lib/planStore'

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetPlanStore()
  resetRegionChoice()
})

// jsdom doesn't implement scrolling, which the router calls on navigation.
window.scrollTo = () => {}
