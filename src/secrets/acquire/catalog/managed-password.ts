// The two password lifecycles Weles administers, and the coordinates that
// address a directory identity.
//
// A password is not acquired: it already exists at the provider and is adopted,
// rotated, reset, or merely proven. That is why these two definitions are built
// per credential id instead of sitting in the registered table next door — the
// item is named by the caller, and the provider it names picks which lifecycle
// owns it.
//
// The four constants below live here rather than with the queueing code because
// they are the same fact the definitions state: what a Microsoft Entra identity
// is. ENTRA_ORIGIN is the origin the Skarbiec contract must pin, and the two
// patterns are the shapes a UPN and a directory id have to have before any
// caller may claim one.

import type { SecretDefinition } from '../catalog.js';

export function microsoftPasswordDefinition(credentialId: string): SecretDefinition {
  return {
    secret: credentialId,
    provider: 'microsoft',
    displayName: 'Microsoft account password',
    envVars: [],
    defaultPurpose: 'microsoft-account-security',
    formUrl: 'https://account.live.com/password/Change',
    flowName: 'microsoft-password-lifecycle',
    endpoints: ['Microsoft account sign-in'],
    usageText: 'Adopt, rotate, or verify one exact Microsoft account password and commit it to Skarbiec only after a fresh password login succeeds.',
    dailyRequests: '1',
    requestedScopes: [],
    capabilities: ['password_adoption', 'password_rotation', 'fresh_login_verification'],
    runtimeInstall: false,
    headless: false,
    storeSecretTarget: 'skarbiec',
    operations: ['adopt', 'rotate', 'verify'],
  };
}

export const ENTRA_PROVIDER = 'microsoft_entra';
export const ENTRA_ORIGIN = 'https://login.microsoftonline.com';
export const ENTRA_UPN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const LOWER_UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

// Entra directory items and consumer Microsoft accounts are both declared managed
// passwords (isWelesManagedPasswordItem); the requested provider selects which
// lifecycle owns the item, so a directory identity is never administered through a
// consumer-account surface. The provider is the caller declaring which lifecycle it
// wants, not a fact read out of the id.
export function entraPasswordDefinition(credentialId: string): SecretDefinition {
  return {
    secret: credentialId,
    provider: ENTRA_PROVIDER,
    displayName: 'Microsoft Entra account password',
    envVars: [],
    defaultPurpose: 'entra-account-security',
    formUrl: ENTRA_ORIGIN,
    flowName: 'microsoft-entra-password-lifecycle',
    endpoints: ['Microsoft Entra sign-in'],
    usageText: 'Adopt, rotate, reset, or verify one exact Microsoft Entra directory password and commit it to Skarbiec only after the signed-in tenant, principal object id, and UPN are confirmed by a fresh login.',
    dailyRequests: '1',
    requestedScopes: [],
    capabilities: ['password_adoption', 'password_rotation', 'password_reset', 'fresh_login_verification'],
    runtimeInstall: false,
    headless: false,
    storeSecretTarget: 'skarbiec',
    operations: ['adopt', 'rotate', 'reset', 'verify'],
  };
}
