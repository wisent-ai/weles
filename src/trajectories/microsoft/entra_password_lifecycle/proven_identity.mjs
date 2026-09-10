// What Entra itself proves about the tenant and the principal: the token claims
// the first-party My Account SPA mints for the signed-in session, the hard gate
// every password write and every Skarbiec commit sits behind, and the directory
// binding of the UPN domain that needs no password at all.
//
// Moved out of entra_password_lifecycle.mjs, which keeps the three trajectory
// entry points.

import { humanIdlePause } from '../../../../dist/human/mouse.js';

import {
  AUTHORIZED_CONTEXT_HOST,
  AUTHORIZED_CONTEXT_URL,
  EMAIL,
  LOWER_UUID,
  SIGN_IN_ORIGIN,
} from './queued_job.mjs';

const ANY_UUID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i;
const JWT_SCAN = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g;

function decodedTokenClaims(token) {
  const segments = token.split('.');
  if (segments.length !== Number('3')) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[Number('1')], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function claimedIdentities(values) {
  const identities = [];
  for (const value of values) {
    for (const [token] of String(value).matchAll(JWT_SCAN)) {
      const claims = decodedTokenClaims(token);
      if (!claims) continue;
      const tid = typeof claims.tid === 'string' ? claims.tid.trim().toLowerCase() : '';
      const oid = typeof claims.oid === 'string' ? claims.oid.trim().toLowerCase() : '';
      if (!LOWER_UUID.test(tid) || !LOWER_UUID.test(oid)) continue;
      const named = [claims.preferred_username, claims.upn, claims.unique_name]
        .find((candidate) => typeof candidate === 'string' && EMAIL.test(candidate.trim()));
      // idp is present only when the signing identity provider differs from the
      // resource tenant, which is exactly the guest case this trajectory must
      // refuse: a federated principal carries the resource tenant in tid and its
      // guest object id in oid, so tid and oid alone cannot tell it apart from a
      // directory-managed member.
      const idp = typeof claims.idp === 'string' ? claims.idp.trim().toLowerCase() : '';
      identities.push({ tid, oid, upn: named ? named.trim().toLowerCase() : '', idp });
    }
  }
  return identities;
}

// Second claim source: the bearer tokens the authorized first-party SPA attaches
// to its own API calls. Tokens stay in memory, are only ever base64-decoded for
// their claim set, and are dropped by clearBearerTokens once asserted.
export function trackBearerTokens(page, sink) {
  page.on('request', (request) => {
    const header = request.headers().authorization ?? '';
    if (!/^Bearer\s+eyJ/i.test(header)) return;
    if (sink.length >= Number('64')) return;
    sink.push(header.replace(/^Bearer\s+/i, ''));
  });
}

export function clearBearerTokens(sink) {
  sink.splice(''.length, sink.length);
}

// The token cache of the authorized context is evidence. A storage this run
// could not read is a named refusal carrying the reason, never an empty claim
// list that reads like a session which minted nothing.
async function storedTokenValues(page) {
  try {
    const values = await page.evaluate(() => {
      const found = [];
      for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
        if (!store) continue;
        for (let index = ''.length; index < store.length; index += 'x'.length) {
          const key = store.key(index);
          if (key === null) continue;
          const value = store.getItem(key);
          if (typeof value === 'string') found.push(value);
        }
      }
      return found;
    });
    return { ok: true, values };
  } catch (error) {
    return { ok: false, reason: `the authorized context token storage could not be read: ${error.message}` };
  }
}

async function authorizedClaims(page, sink) {
  const stored = await storedTokenValues(page);
  if (!stored.ok) {
    return { ok: false, reason: stored.reason, identities: claimedIdentities(sink) };
  }
  return { ok: true, identities: claimedIdentities([...stored.values, ...sink]) };
}

// The authorized context has to be open before its claims can be read; a
// navigation that never landed is the same refusal as claims that never
// appeared, and it names the navigation failure.
async function openAuthorizedContext(page) {
  try {
    await page.goto(AUTHORIZED_CONTEXT_URL, { waitUntil: 'domcontentloaded' });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `the authorized Entra context could not be opened: ${error.message}` };
  }
}

// Hard gate. Every password write and every Skarbiec commit sits behind this.
export async function assertEntraIdentity(session, contract, sink) {
  const page = session.page;
  if (!AUTHORIZED_CONTEXT_HOST.test(new URL(page.url()).hostname)) {
    const opened = await openAuthorizedContext(page);
    if (!opened.ok) {
      return {
        ok: false,
        code: 'ENTRA_IDENTITY_UNVERIFIED',
        retryable: true,
        reason: opened.reason,
      };
    }
    await humanIdlePause('deliberate');
  }
  let claims = { ok: true, identities: [] };
  const deadline = Date.now() + Number('60000');
  while (Date.now() < deadline) {
    claims = await authorizedClaims(page, sink);
    if (claims.identities.length) break;
    await page.waitForTimeout(Number('2000'));
  }
  const identities = claims.identities;
  clearBearerTokens(sink);
  if (!identities.length) {
    return {
      ok: false,
      code: 'ENTRA_IDENTITY_UNVERIFIED',
      retryable: true,
      reason: claims.ok
        ? 'the authorized Entra session exposed no readable tid and oid claims'
        : `the authorized Entra session exposed no readable tid and oid claims: ${claims.reason}`,
    };
  }
  const directoryMatches = identities.every((identity) => identity.tid === contract.tenantId
    && identity.oid === contract.principalObjectId);
  const conflictingUpn = identities.some((identity) => identity.upn && identity.upn !== contract.accountUpn);
  const confirmedUpn = identities.some((identity) => identity.upn === contract.accountUpn);
  if (!directoryMatches || conflictingUpn || !confirmedUpn) {
    return {
      ok: false,
      code: 'ENTRA_IDENTITY_MISMATCH',
      retryable: false,
      reason: 'the signed-in Entra identity does not match the queued tenant, principal object id, and UPN',
    };
  }
  // A guest federated from another identity provider -- in practice a personal
  // Microsoft account homed in the consumer tenant 9188040d-6c67-4c5b-b112-36a304b66dad
  // -- satisfies tid, oid and UPN while its password lives outside this
  // directory. Entra's ChangePassword surface does not administer it, so the run
  // would reach the write, fail to prove what the directory holds, and quarantine
  // a credential. Refuse before any write, and name the surface that does own it.
  const federated = identities.find((identity) => identity.idp);
  if (federated) {
    return {
      ok: false,
      code: 'ENTRA_IDENTITY_NOT_DIRECTORY_MANAGED',
      retryable: false,
      reason: `the signed-in principal is a guest federated from ${federated.idp}, whose password this directory does not hold; a consumer Microsoft account is rotated through the microsoft_reset_password lifecycle, not the Entra one`,
    };
  }
  return { ok: true };
}

// Directory binding proof that needs no password: the issuer of the UPN domain's
// OpenID configuration is the tenant that owns the domain. Every way this proof
// can be missing answers with its own reason, so 'the domain resolves to another
// tenant' is never confused with 'the discovery document was not readable'.
export async function tenantOfUpnDomain(accountUpn) {
  const domain = accountUpn.slice(accountUpn.lastIndexOf('@') + 'x'.length);
  const discovery = `${SIGN_IN_ORIGIN}/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`;
  let response;
  try {
    response = await fetch(discovery);
  } catch (error) {
    return { ok: false, reason: `the OpenID configuration of the UPN domain ${domain} could not be requested: ${error.message}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `the OpenID configuration of the UPN domain ${domain} answered HTTP ${response.status}` };
  }
  let document;
  try {
    document = await response.json();
  } catch (error) {
    return { ok: false, reason: `the OpenID configuration of the UPN domain ${domain} was not readable JSON: ${error.message}` };
  }
  const issuer = typeof document?.issuer === 'string' ? document.issuer : '';
  const found = issuer.match(ANY_UUID);
  if (!found) {
    return { ok: false, reason: `the OpenID configuration issuer of the UPN domain ${domain} names no tenant id` };
  }
  return { ok: true, tenantId: found[''.length].toLowerCase() };
}
