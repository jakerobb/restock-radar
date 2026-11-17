import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { resetPlanStore } from '../lib/planStore'

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetPlanStore()
})

// jsdom doesn't implement scrolling, which the router calls on navigation.
window.scrollTo = () => {}
