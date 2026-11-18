import { createRootRoute, createRoute, createRouter, Outlet, redirect, type RouterHistory } from '@tanstack/react-router'
import App from './App'
import ComparePage, { validateCompareSearch } from './components/ComparePage'
import FindPage, { validateFindSearch } from './components/FindPage'
import PlanPage, { validatePlanSearch } from './components/PlanPage'
import { encodePlan, parsePlan } from './lib/plan'
import ProductPage from './components/ProductPage'
import StatusPage from './components/StatusPage'

const rootRoute = createRootRoute({ component: Outlet })

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: App }),
  createRoute({ getParentRoute: () => rootRoute, path: '/status', component: StatusPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/find', component: FindPage, validateSearch: validateFindSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: '/compare', component: ComparePage, validateSearch: validateCompareSearch }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/plan',
    component: PlanPage,
    validateSearch: validatePlanSearch,
    // Links made before plans got a slug of their own.
    beforeLoad: ({ search }) => {
      if (search.l) throw redirect({ to: '/plan/$slug', params: { slug: encodePlan(parsePlan(search.l)) }, replace: true })
    },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/plan/$slug', component: PlanPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/p/$region/$slug', component: ProductPage }),
])

/** The app's routes. Tests pass a memory history. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history, defaultPreload: 'intent' })
}
