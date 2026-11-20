import type { Product } from '../api/types'

/** The storefronts the server can track: what to call each, and which flag stands for it. */
export const REGIONS: Record<string, { name: string; flag: string }> = {
  us: { name: 'United States', flag: 'us' },
  ca: { name: 'Canada', flag: 'ca' },
  eu: { name: 'Europe', flag: 'eu' },
  uk: { name: 'United Kingdom', flag: 'gb' },
  jp: { name: 'Japan', flag: 'jp' },
  br: { name: 'Brazil', flag: 'br' },
  tw: { name: 'Taiwan', flag: 'tw' },
  sg: { name: 'Singapore', flag: 'sg' },
}

/** The name to show for a region id, which for one we don't know is the id itself. */
export function regionName(id: string): string {
  return REGIONS[id]?.name ?? id.toUpperCase()
}

/** Countries whose people shop at the European store. */
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT',
  'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
])

const COUNTRY_REGION: Record<string, string> = { US: 'us', CA: 'ca', GB: 'uk', JP: 'jp', BR: 'br', TW: 'tw', SG: 'sg' }
const LANGUAGE_REGION: Record<string, string> = { ja: 'jp' }

/** The region a browser language tag ("en-GB", "ja", "zh-Hant-TW") points at, if any. */
export function regionForLanguage(tag: string): string | undefined {
  const parts = tag.split('-')
  const language = (parts[0] ?? '').toLowerCase()
  const country = parts.slice(1).find((p) => /^[A-Za-z]{2}$/.test(p))?.toUpperCase()
  if (country) {
    if (COUNTRY_REGION[country]) return COUNTRY_REGION[country]
    if (EU_COUNTRIES.has(country)) return 'eu'
    return undefined
  }
  if (language === 'zh' && /hant/i.test(tag)) return 'tw'
  // Brazil is the only region that speaks Portuguese without a country to say otherwise.
  return LANGUAGE_REGION[language] ?? (language === 'pt' ? 'br' : undefined)
}

/**
 * The region to start in: the one chosen before, else the first of the browser's
 * languages that points at an available region, else the US, else the first.
 */
export function pickRegion(available: string[], stored: string | null, languages: readonly string[]): string {
  if (stored && available.includes(stored)) return stored
  for (const tag of languages) {
    const region = regionForLanguage(tag)
    if (region && available.includes(region)) return region
  }
  return available.includes('us') ? 'us' : (available[0] ?? 'us')
}

/** What is in `products` that belongs to the region. */
export function inRegion<T extends Pick<Product, 'region'>>(products: T[], region: string): T[] {
  return products.filter((p) => p.region === region)
}

const STORAGE_KEY = 'restock-radar.region'

export function readStoredRegion(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeRegion(region: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, region)
  } catch {
    // Private windows and blocked storage just forget the choice.
  }
}
