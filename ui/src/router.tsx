import { createRootRoute, createRoute, createRouter, Outlet, type RouterHistory } from '@tanstack/react-router'
import App from './App'
import AboutPage from './components/AboutPage'
import ComparePage, { validateCompareSearch } from './components/ComparePage'
import FindPage, { validateFindSearch } from './components/FindPage'
import PlanPage from './components/PlanPage'
import ProductPage from './components/ProductPage'
import StatusPage from './components/StatusPage'

const rootRoute = createRootRoute({ component: Outlet })

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: App }),
  createRoute({ getParentRoute: () => rootRoute, path: '/status', component: StatusPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/about', component: AboutPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/find', component: FindPage, validateSearch: validateFindSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: '/compare', component: ComparePage, validateSearch: validateCompareSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: '/plan', component: PlanPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/plan/$slug', component: PlanPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/p/$region/$slug', component: ProductPage }),
])

/** The app's routes. Tests pass a memory history. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history, defaultPreload: 'intent' })
}
