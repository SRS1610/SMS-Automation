/**
 * Gateway routing. For a destination country, the candidate gateways are the
 * enabled ones that either list that country or cover all countries.
 * Gateways that explicitly list the country come first ("specific beats
 * catch-all"); ties are broken by priority (lower number first), then name.
 * The first candidate is used, the rest are fail-over targets.
 */

export interface RoutableProvider {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  countries: string[];
}

export function providersForCountry<T extends RoutableProvider>(providers: T[], country: string | null): T[] {
  return providers
    .filter((p) => p.enabled && (p.countries.length === 0 || (country !== null && p.countries.includes(country))))
    .sort((a, b) => {
      const aSpecific = a.countries.length > 0 ? 0 : 1;
      const bSpecific = b.countries.length > 0 ? 0 : 1;
      return aSpecific - bSpecific || a.priority - b.priority || a.name.localeCompare(b.name);
    });
}
