// The Entra identity this run is signed in as, proven from the tokens the
// authorized first-party context minted, before any password is written.

import { randomUUID } from 'node:crypto';

import { pageSettled } from '../../_shared/page/settled.mjs';

import {
  AUTHORIZED_CONTEXT_HOST,
  AUTHORIZED_CONTEXT_URL,
  EMAIL,
  LOWER_UUID,
  SIGN_IN_ORIGIN,
} from './queued_job.mjs';

/** A UUID anywhere in a text, its shape read from a UUID, as queued_job.mjs reads it. */
const ANY_UUID = new RegExp(randomUUID().replace(/[\da-f]/g, '[\\da-f]'), 'i');
// A compact JWS: header, payload and signature, each base64url (RFC 7515
// section 7.1), the payload captured.
const JWT_SCAN = /eyJ[\w-]+\.(?<payload>[\w-]+)\.[\w-]*/g;

// `promise` settled as an outcome: its value, or the refusal `describe` makes
// of its error, so a caller answers with the cause instead of throwing it.
function settled(promise, describe) {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, reason: describe(error.message) }),
  );
}

// The claim set of a token's payload, or why it is none: a token-shaped string
// in storage is not necessarily a token, and one that is not is named.
async function decodedTokenClaims(payload) {
  const text = Buffer.from(payload, 'base64url').toString('utf8');
  const parsed = await settled(
    new Response(text).json(),
    (cause) => `a token-shaped value whose payload is not JSON (${cause})`,
  );
  if (!parsed.ok) return parsed;
  const { value } = parsed;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      reason: 'a token-shaped value whose payload is not a JSON object',
    };
  }
  return { ok: true, value };
}

// A claim's text, trimmed and lowercased, or null when the token states none.
function claim(claims, name) {
  return typeof claims[name] === 'string'
    ? claims[name].trim().toLowerCase()
    : null;
}

// The identities the token-shaped values carry, and what could not be read of
// the ones that are not tokens.
async function claimedIdentities(values) {
  const identities = [];
  const unreadable = [];
  for (const value of values) {
    for (const match of String(value).matchAll(JWT_SCAN)) {
      const decoded = await decodedTokenClaims(match.groups.payload);
      if (!decoded.ok) {
        unreadable.push(decoded.reason);
        continue;
      }
      const claims = decoded.value;
      const tid = claim(claims, 'tid');
      const oid = claim(claims, 'oid');
      if (!LOWER_UUID.test(tid) || !LOWER_UUID.test(oid)) continue;
      const named = [
        claims.preferred_username,
        claims.upn,
        claims.unique_name,
      ].find(
        (candidate) =>
          typeof candidate === 'string' && EMAIL.test(candidate.trim()),
      );
      // idp is present only when the signing identity provider differs from the
      // resource tenant, which is exactly the guest case this trajectory must
      // refuse: a federated principal carries the resource tenant in tid and its
      // guest object id in oid, so tid and oid alone cannot tell it apart from a
      // directory-managed member.
      identities.push({
        tid,
        oid,
        upn: named === undefined ? null : named.trim().toLowerCase(),
        idp: claim(claims, 'idp'),
      });
    }
  }
  return { identities, unreadable };
}

// Second claim source: the bearer tokens the authorized first-party SPA attaches
// to its own API calls. Tokens stay in memory, are only ever base64-decoded for
// their claim set, and are dropped by clearBearerTokens once asserted.
export function trackBearerTokens(page, sink) {
  page.on('request', (request) => {
    const header = request.headers().authorization;
    if (typeof header !== 'string' || !/^Bearer\s+eyJ/i.test(header)) return;
    sink.push(header.replace(/^Bearer\s+/i, ''));
  });
}

export function clearBearerTokens(sink) {
  while (sink.length) sink.pop();
}

// The token cache of the authorized context is evidence. A storage this run
// could not read is a named refusal carrying the reason, never an empty claim
// list that reads like a session which minted nothing.
function storedTokenValues(page) {
  return settled(
    page.evaluate(() =>
      [globalThis.sessionStorage, globalThis.localStorage]
        .filter(Boolean)
        .flatMap((store) => Object.values({ ...store }))
        .filter((value) => typeof value === 'string'),
    ),
    (cause) =>
      `the authorized context token storage could not be read: ${cause}`,
  );
}

async function authorizedClaims(page, sink) {
  const stored = await storedTokenValues(page);
  if (!stored.ok) {
    return {
      ok: false,
      reason: stored.reason,
      ...(await claimedIdentities(sink)),
    };
  }
  return { ok: true, ...(await claimedIdentities([...stored.value, ...sink])) };
}

// Hard gate. Every password write and every Skarbiec commit sits behind this.
export async function assertEntraIdentity(session, contract, sink) {
  const page = session.page;
  if (!AUTHORIZED_CONTEXT_HOST.test(new URL(page.url()).hostname)) {
    // The authorized context has to be open before its claims can be read; a
    // navigation that never landed is the same refusal as claims that never
    // appeared, and it names the navigation failure.
    const opened = await settled(
      page.goto(AUTHORIZED_CONTEXT_URL, { waitUntil: 'domcontentloaded' }),
      (cause) => `the authorized Entra context could not be opened: ${cause}`,
    );
    if (!opened.ok) {
      return {
        ok: false,
        code: 'ENTRA_IDENTITY_UNVERIFIED',
        retryable: true,
        reason: opened.reason,
      };
    }
  }
  // The context's tokens are read once the page has finished what opening it
  // started, as the page itself reports it.
  await pageSettled(page);
  const claims = await authorizedClaims(page, sink);
  const { identities } = claims;
  clearBearerTokens(sink);
  if (!identities.length) {
    const causes = [
      ...(claims.ok ? [] : [claims.reason]),
      ...claims.unreadable,
    ];
    return {
      ok: false,
      code: 'ENTRA_IDENTITY_UNVERIFIED',
      retryable: true,
      reason: causes.length
        ? `the authorized Entra session exposed no readable tid and oid claims: ${causes.join('; ')}`
        : 'the authorized Entra session exposed no readable tid and oid claims',
    };
  }
  const directoryMatches = identities.every(
    (identity) =>
      identity.tid === contract.tenantId &&
      identity.oid === contract.principalObjectId,
  );
  const conflictingUpn = identities.some(
    (identity) => identity.upn !== null && identity.upn !== contract.accountUpn,
  );
  const confirmedUpn = identities.some(
    (identity) => identity.upn === contract.accountUpn,
  );
  if (!directoryMatches || conflictingUpn || !confirmedUpn) {
    return {
      ok: false,
      code: 'ENTRA_IDENTITY_MISMATCH',
      retryable: false,
      reason:
        'the signed-in Entra identity does not match the queued tenant, principal object id, and UPN',
    };
  }
  // A guest federated from another identity provider -- in practice a personal
  // Microsoft account homed in the consumer tenant -- satisfies tid, oid and UPN
  // while its password lives outside this directory. Entra's ChangePassword
  // surface does not administer it, so the run would reach the write, fail to
  // prove what the directory holds, and quarantine a credential. Refuse before
  // any write, and name the surface that does own it.
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
  const [, domain] = accountUpn.split(/@(?=[^@]+$)/);
  if (domain === undefined) {
    return { ok: false, reason: `the UPN ${accountUpn} names no domain` };
  }
  const discovery = `${SIGN_IN_ORIGIN}/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`;
  const requested = await settled(
    fetch(discovery),
    (cause) =>
      `the OpenID configuration of the UPN domain ${domain} could not be requested: ${cause}`,
  );
  if (!requested.ok) return requested;
  const response = requested.value;
  if (!response.ok) {
    return {
      ok: false,
      reason: `the OpenID configuration of the UPN domain ${domain} answered HTTP ${response.status}`,
    };
  }
  const read = await settled(
    response.json(),
    (cause) =>
      `the OpenID configuration of the UPN domain ${domain} was not readable JSON: ${cause}`,
  );
  if (!read.ok) return read;
  const document = read.value;
  if (typeof document?.issuer !== 'string') {
    return {
      ok: false,
      reason: `the OpenID configuration of the UPN domain ${domain} states no issuer`,
    };
  }
  const found = document.issuer.match(ANY_UUID);
  if (found === null) {
    return {
      ok: false,
      reason: `the OpenID configuration issuer ${document.issuer} of the UPN domain ${domain} names no tenant id`,
    };
  }
  const [tenant] = found;
  return { ok: true, tenantId: tenant.toLowerCase() };
}
