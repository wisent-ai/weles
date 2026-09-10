// Which vault account performs this scan and how much it has left today. The
// daily usage ledger and the account choice live together because the choice
// reads exactly the ledger the recording writes, so two files could never
// disagree about what an exhausted account means.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getSocialAccount, markCookiesStale, resolveAccountSession } from '../../../../../dist/utils/credentials.js';
import { LABEL } from '../scan_brief.mjs';
import { CookieJarStaleError, loadFreshCookieJarOrFail } from '../../../_shared/cookie-freshness.mjs';
import { listAccounts } from '../../../_shared/skarbiec_accounts.mjs';

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function accountKey(acct) {
  return String(acct?.id || acct?.username || 'unknown');
}

function accountDomain(acct) {
  const raw = String(acct?.metadata?.email || acct?.username || '');
  const hit = raw.toLowerCase().match(/@([^>\s]+)/);
  return hit?.[1] || 'unknown';
}

function usageLedgerPath() {
  return process.env.PANGRAM_ACCOUNT_USAGE_FILE || join(process.env.HOME || process.cwd(), '.weles', 'pangram-account-usage.json');
}

function readUsageLedger() {
  const path = usageLedgerPath();
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function writeUsageLedger(ledger) {
  const path = usageLedgerPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}

function dailyAccountLimit() {
  const raw = Number(process.env.PANGRAM_ACCOUNT_DAILY_SCAN_LIMIT || 4);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
}

function usageCount(ledger, acct) {
  return Number(ledger?.[todayKey()]?.[accountKey(acct)]?.scan_attempts || 0);
}

export function recordAccountUse(acct, stats, pool) {
  if (!acct) return null;
  const ledger = readUsageLedger();
  const day = todayKey();
  ledger[day] = ledger[day] || {};
  const key = accountKey(acct);
  const prev = ledger[day][key] || {};
  ledger[day][key] = {
    account_id: acct.id ?? null,
    username: acct.username ?? null,
    domain: accountDomain(acct),
    scan_attempts: Number(prev.scan_attempts || 0) + 1,
    daily_limit: dailyAccountLimit(),
    last_input_sha256: stats.sha256,
    last_used_at: new Date().toISOString(),
    pool_available_before_run: pool?.available_count ?? null,
  };
  writeUsageLedger(ledger);
  return ledger[day][key];
}

export function markAccountExhausted(acct, stats, pool, reason, creditState = null) {
  if (!acct) return null;
  const ledger = readUsageLedger();
  const day = todayKey();
  ledger[day] = ledger[day] || {};
  const key = accountKey(acct);
  const prev = ledger[day][key] || {};
  ledger[day][key] = {
    ...prev,
    account_id: acct.id ?? null,
    username: acct.username ?? null,
    domain: accountDomain(acct),
    scan_attempts: dailyAccountLimit(),
    daily_limit: dailyAccountLimit(),
    exhausted: true,
    exhausted_reason: reason,
    credit_state: creditState,
    last_input_sha256: stats.sha256,
    last_used_at: new Date().toISOString(),
    pool_available_before_run: pool?.available_count ?? null,
  };
  writeUsageLedger(ledger);
  return ledger[day][key];
}

function domainSummary(accounts) {
  const counts = {};
  for (const acct of accounts || []) {
    const domain = accountDomain(acct);
    counts[domain] = (counts[domain] || 0) + 1;
  }
  return counts;
}

async function fetchActivePangramAccounts() {
  const accounts = listAccounts('pangram');
  const accountId = process.env.ACCOUNT_ID?.trim();
  const selected = accountId ? accounts.filter((account) => account.id === accountId) : accounts;
  const limit = Math.max(1, Number(process.env.PANGRAM_ACCOUNT_POOL_LIMIT || '100'));
  return {
    accounts: selected.slice(0, limit).map((account) => ({
      ...account,
      created_at: account.document.context?.created_at ?? null,
    })),
    reason: selected.length ? null : 'no_account',
  };
}

function createdAtMillis(acct) {
  const raw = acct.created_at;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new Error(`pangram_account_created_at_unreadable account=${accountKey(acct)} value=${String(raw).slice(0, 120)}`);
  return parsed;
}

function sortCandidatesByUsage(accounts, ledger) {
  return [...accounts].sort((a, b) => {
    const usageDelta = usageCount(ledger, a) - usageCount(ledger, b);
    if (usageDelta !== 0) return usageDelta;
    const createdA = createdAtMillis(a);
    const createdB = createdAtMillis(b);
    if (createdA === null && createdB === null) return 0;
    if (createdA === null) return 1;
    if (createdB === null) return -1;
    return createdB - createdA;
  });
}

async function selectSingleConfiguredAccount() {
  const acct = await getSocialAccount('pangram');
  if (!acct) return { account: null, reason: 'no_account', pool: { available_count: 0, total_accounts: 0 } };
  const sessionOpts = await resolveAccountSession(acct);
  const cookies = loadFreshCookieJarOrFail(acct, {
    platform: 'pangram',
    label: LABEL,
    currentProxyUrl: sessionOpts.proxyUrl,
    currentPersona: sessionOpts.persona,
  });
  return { account: acct, sessionOpts, cookies, reason: null, pool: { available_count: 1, total_accounts: 1 } };
}

// An account of the pool either can scan now or it cannot, and "cannot" is a
// named answer of this module rather than a swallowed error: the reason is
// recorded in the rejection evidence and a stale jar is flagged on the account.
async function prepareCandidateAccount(acct) {
  try {
    const sessionOpts = await resolveAccountSession(acct);
    const cookies = loadFreshCookieJarOrFail(acct, {
      platform: 'pangram',
      label: LABEL,
      currentProxyUrl: sessionOpts.proxyUrl,
      currentPersona: sessionOpts.persona,
    });
    return { usable: true, sessionOpts, cookies };
  } catch (err) {
    const reason = err instanceof CookieJarStaleError ? (err.details?.reason || 'stale_cookies') : (err.message || 'account_unusable');
    if (err instanceof CookieJarStaleError && acct.id) {
      try {
        await markCookiesStale(acct.id);
      } catch (markError) {
        throw new Error(`pangram account ${accountKey(acct)} cannot scan: ${err.message}; and its cookie jar stayed unmarked: ${markError.message}`, { cause: err });
      }
    }
    return { usable: false, reason: String(reason) };
  }
}

export async function selectPangramAccountForRun() {
  if (process.env.PANGRAM_ACCOUNT_ROTATION === '0') return selectSingleConfiguredAccount();

  const fetched = await fetchActivePangramAccounts();
  const ledger = readUsageLedger();
  const limit = dailyAccountLimit();
  const accounts = fetched.accounts || [];
  const underLimit = accounts.filter((acct) => usageCount(ledger, acct) < limit);
  const ordered = sortCandidatesByUsage(underLimit, ledger);
  const rejected = [];

  for (const acct of ordered) {
    const prepared = await prepareCandidateAccount(acct);
    if (prepared.usable) {
      return {
        account: acct,
        sessionOpts: prepared.sessionOpts,
        cookies: prepared.cookies,
        reason: null,
        pool: {
          total_accounts: accounts.length,
          available_count: ordered.length,
          rejected_count: rejected.length,
          daily_limit_per_account: limit,
          selected_usage_before_run: usageCount(ledger, acct),
          domains: domainSummary(accounts),
        },
      };
    }
    rejected.push({ account_id: acct.id ?? null, username: acct.username ?? null, reason: prepared.reason.slice(0, 120) });
  }

  const exhaustedByUsage = accounts.length > 0 && underLimit.length === 0;
  return {
    account: null,
    reason: exhaustedByUsage ? 'quota_exhausted' : (fetched.reason || 'no_fresh_account'),
    pool: {
      total_accounts: accounts.length,
      available_count: ordered.length,
      exhausted_by_daily_limit: accounts.length - underLimit.length,
      rejected_count: rejected.length,
      rejected_accounts: rejected.slice(0, 10),
      daily_limit_per_account: limit,
      domains: domainSummary(accounts),
    },
  };
}

export async function injectCookies(s, acct, sessionOpts, preloadedCookies = null) {
  const cookies = preloadedCookies || loadFreshCookieJarOrFail(acct, {
    platform: 'pangram',
    label: LABEL,
    currentProxyUrl: sessionOpts.proxyUrl,
    currentPersona: sessionOpts.persona,
  });
  const wanted = cookies.filter((c) => String(c.domain || '').includes('pangram.com'));
  if (!wanted.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: no pangram.com cookies', { platform: 'pangram', label: LABEL, reason: 'no_domain_match', account_id: acct?.id ?? null });
  await s.ctx.addCookies(wanted);
  return wanted.length;
}
