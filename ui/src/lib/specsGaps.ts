import type { Product, SpecsGapsResponse } from '../api/types'
import { baseSlug } from './convertPlan'
import type { SpecsGap } from './planChecks'

/** The slugs (without region suffix) of the products marked as having no tech specs to expect. */
export const notExpectedSlugs = (r: SpecsGapsResponse | undefined): Set<string> => new Set((r?.not_expected ?? []).map((e) => e.slug))

/** Whether a product is marked as having no tech specs to expect, in whichever region it is sold. */
export const isSpecsNotExpected = (slug: string, marked: Set<string>): boolean => marked.has(baseSlug(slug))

/**
 * Why a product has no specs, as far as is known: undefined when it isn't known (the list hasn't loaded, or the
 * product isn't on it because it has some).
 */
export function specsGapOf(product: Product | undefined, r: SpecsGapsResponse | undefined): SpecsGap | undefined {
  if (!product || !r) return undefined
  if (isSpecsNotExpected(product.slug, notExpectedSlugs(r))) return 'not-expected'
  const g = r.products.find((x) => x.region === product.region && x.slug === product.slug)
  if (!g) return undefined
  if (g.fetched_at === null) return 'pending'
  return g.published ? 'unusable' : 'none'
}
