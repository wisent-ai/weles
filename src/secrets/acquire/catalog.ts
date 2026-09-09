// Which credential a request is actually about.
//
// Everything downstream — the objective sentences, the queued job payload, the
// lifecycle gates — takes a SecretDefinition and asks it questions. This file
// owns that shape and the single resolution from a caller's loose wording to
// exactly one definition, so there is one answer to "which credential is this"
// and not one per queueing path.
//
// The three sources a definition can come from are separated below it: a managed
// password lifecycle, the enumerated provider table, and a slug nobody
// enumerated. Resolution consults them in that order because it is an order of
// authority — a declared managed password is addressed by its own item id and
// must never be re-read as an API key, and a registered provider must never be
// re-derived from its slug.
//
// The Entra coordinates are re-exported by name because the lifecycle gates and
// the plan builder check a request against exactly the patterns the Entra
// definition was built from; a second copy of those patterns could disagree with
// the definition that uses them.

import { isWelesManagedPasswordItem } from '../scoped-service.js';
import type { AcquireSecretRequest } from './request.js';
import {
  entraPasswordDefinition,
  microsoftPasswordDefinition,
  ENTRA_ORIGIN,
  ENTRA_PROVIDER,
  ENTRA_UPN,
  LOWER_UUID,
} from './catalog/managed-password.js';
import {
  FIGMA_PERSONAL_ACCESS_TOKEN,
  GITHUB_ADMIN_TOKEN,
  SECRET_REGISTRY,
  SEMANTIC_SCHOLAR,
  SNAPCHAT_SNAP_KIT_API_TOKEN,
} from './catalog/registered-providers.js';
import { genericDefinition } from './catalog/unregistered-provider.js';

export { ENTRA_ORIGIN, ENTRA_PROVIDER, ENTRA_UPN, LOWER_UUID };

export type SecretDefinition = {
	secret: string;
	provider: string;
	displayName: string;
	envVars: string[];
	defaultPurpose: string;
	formUrl: string;
	flowName: string;
	endpoints: string[];
	usageText: string;
	dailyRequests: string;
	requestedScopes: string[];
	capabilities: string[];
	runtimeInstall: boolean;
	headless: boolean;
  storeSecretTarget: 'skarbiec';
  operations?: string[];
  // Only a derived generic definition carries this: it is the site the caller
  // declared for an unenumerated provider, empty when none was declared. A
  // registered definition leaves it absent and keeps the origin its exact
  // Skarbiec contract pins.
  sourceOrigin?: string;
};

export function normalizeSecret(request: AcquireSecretRequest): string {
  const credentialId = request.credentialId?.trim().toLowerCase() ?? '';
  // A declared managed password is addressed by its own item id, so it passes
  // through unchanged. The declaration table decides that, never the id's spelling.
  if (isWelesManagedPasswordItem(credentialId)) return credentialId;
  const explicit = request.secret?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  // Both branches of the conditional this replaced returned the same string: it was
  // born inert in 5734aff2 as `explicit.includes('.') ? explicit.replace(/_/g, '_')
  // : explicit`, so no behaviour is lost. Dotted registry keys are already matched
  // against their underscore spelling at lookup time in definitionFor below.
  if (explicit) return explicit;
  const goal = request.goal?.toLowerCase() ?? '';
  if ((goal.includes('semantic') && goal.includes('scholar')) || goal.includes('semanticscholar') || goal.includes('s2')) {
    return SEMANTIC_SCHOLAR.secret;
  }
  if (goal.includes('github') && (goal.includes('admin') || goal.includes('org') || goal.includes('token'))) {
    return GITHUB_ADMIN_TOKEN.secret;
  }
  if (goal.includes('figma') && (goal.includes('api') || goal.includes('token') || goal.includes('asset') || goal.includes('design'))) {
    return FIGMA_PERSONAL_ACCESS_TOKEN.secret;
  }
  if (goal.includes('snapchat') && (goal.includes('api') || goal.includes('token') || goal.includes('snap kit'))) {
    return SNAPCHAT_SNAP_KIT_API_TOKEN.secret;
  }
  return '';
}

export function definitionFor(request: AcquireSecretRequest): SecretDefinition | null {
  const normalized = normalizeSecret(request);
  if (isWelesManagedPasswordItem(normalized)) {
    return request.provider === ENTRA_PROVIDER
      ? entraPasswordDefinition(normalized)
      : microsoftPasswordDefinition(normalized);
  }
  const registered = normalized
    ? SECRET_REGISTRY[normalized] ?? SECRET_REGISTRY[normalized.replace(/\./g, '_')] ?? null
    : null;
  return registered ?? genericDefinition(request);
}
