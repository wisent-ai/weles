// What a provider's credentials look like, keyed by the provider name
// `providerFromHost` derives from the endpoint and by the pool type the
// Skarbiec row declares. Nothing here reads a display name.
import type { WelesServiceSecret } from '../../secrets/scoped-service.js';

export type ProxyType = 'isp' | 'mobile' | 'residential';

// The declared pool type of a row, or undefined when the row declares none
// or something that is not a pool type.
export function proxyTypeOf(value: unknown): ProxyType | undefined {
  switch (value) {
    case 'isp': return 'isp';
    case 'mobile': return 'mobile';
    case 'residential': return 'residential';
    default: return undefined;
  }
}

// The scoped Skarbiec service that holds this provider pool's credentials.
export function secretServiceFor(provider: string | undefined, proxyType: ProxyType | undefined): WelesServiceSecret | undefined {
  switch (provider) {
    case 'decodo': return 'decodoIsp';
    case 'oxylabs':
      if (proxyType === 'isp') return 'oxylabsDedicatedIsp';
      if (proxyType === 'mobile') return 'oxylabsMobile';
      return 'oxylabsResidential';
    case 'packetstream': return 'packetstreamProxy';
    case 'iproyal': return proxyType === 'mobile' ? 'iproyalMobileProxy' : 'iproyalProxy';
    case 'pingproxies': return 'pingproxiesProxy';
    case 'brightdata': return 'brightdataProxy';
    default: return undefined;
  }
}

export type StickySession = { country: string; city?: string; sessionId: string | number };

// The provider's credentials for one sticky session, pinned to a country
// and, where the provider takes one, a city. A static (ISP) pool and a
// provider with no session shape get the base credentials unchanged.
export function stickyCredentials(
  provider: string | undefined,
  proxyType: ProxyType | undefined,
  base: { username: string; password: string },
  session: StickySession,
): { username: string; password: string } {
  if (proxyType === 'isp') return base;
  const country = session.country.toLowerCase();
  const { username, password } = base;
  switch (provider) {
    case 'oxylabs': {
      const city = session.city ? `-city-${session.city}` : '';
      const customer = username.startsWith('customer-') ? username.slice('customer-'.length) : username;
      return { username: `customer-${customer}-cc-${country}${city}-sessid-${session.sessionId}`, password };
    }
    case 'packetstream': return { username, password: `${password}_country-${country.toUpperCase()}_session-${session.sessionId}` };
    case 'iproyal': return { username, password: `${password}_country-${country}_session-${session.sessionId}` };
    case 'pingproxies': return { username: `${username}_c_${country}_s_${session.sessionId}`, password };
    case 'brightdata': return { username: `${username}-country-${country}-session-${session.sessionId}`, password };
    default: return base;
  }
}
