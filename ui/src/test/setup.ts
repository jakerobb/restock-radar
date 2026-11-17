import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

// jsdom doesn't implement scrolling, which the router calls on navigation.
window.scrollTo = () => {}
