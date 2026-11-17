import { createRootRoute, createRoute, createRouter, Outlet, type RouterHistory } from '@tanstack/react-router'
import App from './App'
import FindPage, { validateFindSearch } from './components/FindPage'
import ProductPage from './components/ProductPage'
import StatusPage from './components/StatusPage'

const rootRoute = createRootRoute({ component: Outlet })

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: App }),
  createRoute({ getParentRoute: () => rootRoute, path: '/status', component: StatusPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/find', component: FindPage, validateSearch: validateFindSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: '/p/$region/$slug', component: ProductPage }),
])

/** The app's routes. Tests pass a memory history. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history, defaultPreload: 'intent' })
}
