// The service account behind a Google-SSO balance run: which stored identity
// signs in, and what the dashboard's own wording says the balance is.
//
// Both answers are refusable. An identity that does not match the account the
// caller asked for is an error, not a substitution; a page with no labelled
// balance returns nothing rather than the first price it happened to show.
import { readScopedLogin } from '../../../../_shared/scoped-secrets.mjs';
import { findWelesRecordId, updateWelesRecord } from '../../skarbiec/accounts.mjs';

export function parseBalanceFromText(text) {
  // Require a "Balance:" / "Credits:" / "Wallet:" / "Funds:" labelled
  // match. The earlier first-$X.XX path returned a service price on
  // JuicySMS / FiveSim landing pages (verified live 2026-05-19: JuicySMS
  // post-SSO landed on the rentals homepage whose first row was Discord
  // "$0.53"; the parser reported it as the balance). Now return null when
  // no labelled balance is found, so callers can detect a scrape that
  // landed on the wrong page instead of persisting a misleading number.
  if (!text) return null;
  const labeled = text.match(/(?:balance|credit[s]?|wallet|funds)[^\n$€£]{0,40}\$([0-9]+(?:\.[0-9]{1,4})?)/i);
  if (labeled) return Number(labeled[1]);
  return null;
}

// Resolve the shared Google SSO identity through its exact Skarbiec consumer.
// Callers for Ads, Gmail, Drive, and Workspace admin use their own service
// identities instead of reusing this grant.
export async function getGoogleSsoCreds(email) {
  const login = readScopedLogin('googleSso');
  if (email && login.email.toLowerCase() !== String(email).toLowerCase()) {
    throw new Error('scoped Google SSO identity does not match the requested account');
  }
  return login;
}
export async function getScopedGoogleLogin(serviceName) {
  return readScopedLogin(serviceName);
}

export async function patchServiceBalance(displayName, balance) {
  const id = findWelesRecordId((document) =>
    document.context?.owner === 'weles'
      && String(document.context?.display_name ?? '').toLowerCase() === String(displayName).toLowerCase());
  if (!id) return false;
  const now = new Date().toISOString();
  return updateWelesRecord(id, {
    balance_usd: balance,
    last_balance_check: now,
    updated_at: now,
  });
}
