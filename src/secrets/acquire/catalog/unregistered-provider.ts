// How a provider nobody enumerated still gets a definition.
//
// This is the one place a SecretDefinition is derived from the request rather
// than read from a table, so it is also the one place where the caller supplies
// facts the registered entries state for themselves: the provider slug, the item
// id, and the site to start at. Everything it may not decide is refused here —
// the field must be the generic one, the slug must not collide with a lifecycle
// or a registered provider, and only `acquire` is offered.
//
// It sits beside the registered table because it reads it: a slug that already
// belongs to an enumerated provider must reach that provider's disclosure, never
// a derived one.

import {
  acquiredSecretContract,
  isWelesAcquiredSourceOrigin,
} from '../../scoped-service.js';
import type { AcquireSecretRequest } from '../request.js';
import type { SecretDefinition } from '../catalog.js';
import { ENTRA_PROVIDER } from './managed-password.js';
import { SECRET_REGISTRY } from './registered-providers.js';

// A provider nobody registered above is still acquirable. The shared credential
// contract fixes the slug shape, the api_key field, and acquire as the only
// operation; Skarbiec names the item (the slug, unless the caller passed an
// explicit credential id). Everything else is the registered path unchanged: the
// same scoped-writer gate, the same store_credential contract, the same
// capture-origin check.
const GENERIC_SLUG = /^[a-z\d](?:[a-z\d-]{1,38}[a-z\d])$/;
const GENERIC_FIELD = 'api_key';
const GENERIC_FLOW = 'generic-provider-api-key-acquisition';
// A slug names no site, so a request that declares no signup origin starts the
// browser job at exactly this discovery origin and finds the provider's own
// API-key signup page from there instead of guessing a hostname from the slug.
const GENERIC_DISCOVERY_ORIGIN = 'https://duckduckgo.com';

export function genericDefinition(request: AcquireSecretRequest): SecretDefinition | null {
  const provider = request.provider?.trim().toLowerCase() ?? '';
  if (!GENERIC_SLUG.test(provider)
      || provider === 'microsoft'
      || provider === ENTRA_PROVIDER
      || Object.values(SECRET_REGISTRY).some((definition) => definition.provider === provider)) {
    return null;
  }
  const item = request.credentialId?.trim().toLowerCase() || provider;
  // The Skarbiec contract decides whether this item may be acquired at all: the
  // field must be the generic one, which refuses a registered item, a declared
  // managed password (field `password`), and a scoped service item, so a generic
  // request can never land on another contract's item. An id nobody declared has
  // no managed lifecycle to divert, and reaching this point still requires the
  // caller to have declared a generic provider slug of its own.
  const contract = acquiredSecretContract(item);
  if (!contract || contract.item !== item || contract.field !== GENERIC_FIELD) return null;
  const declaredOrigin = request.signupOrigin?.trim() ?? '';
  const displayName = provider.replace(/-/g, ' ');
  return {
    secret: item,
    provider,
    displayName,
    envVars: [],
    defaultPurpose: `${provider}-api-access`,
    formUrl: isWelesAcquiredSourceOrigin(declaredOrigin)
      ? declaredOrigin
      : `${GENERIC_DISCOVERY_ORIGIN}/?q=${encodeURIComponent(`${displayName} API key sign up`)}`,
    flowName: GENERIC_FLOW,
    endpoints: [`${displayName} API`],
    usageText: `We register one Wisent-owned account with ${displayName} and generate a single API key for programmatic access from our own services. The key is written straight into the encrypted Skarbiec item and never appears in task results, logs, or tool arguments.`,
    dailyRequests: '100',
    requestedScopes: [],
    capabilities: ['account_signup', 'api_key_generation'],
    runtimeInstall: false,
    headless: false,
    storeSecretTarget: 'skarbiec',
    operations: ['acquire'],
    sourceOrigin: declaredOrigin,
  };
}
