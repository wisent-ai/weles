// Atomic queue-claim helper. Extracted from poll.ts to keep that file
// under the 300-line cap.

import type { ActionLogRow } from './poll.js';
import { resolveTrajectory } from './dispatch.js';
import { DATABASE_URL, headers, staleCookieAccounts } from './stale.js';
import os from 'node:os';
import { INSTANCE_ID } from './identity.js';
import type { WelesActionPolicy } from './placement-policy.js';

const LEASE_DEPLOYMENT_ID = process.env.WELES_DEPLOYMENT_ID?.trim() ?? '';
const LEASE_GENERATION = Number(process.env.WELES_DEPLOYMENT_GENERATION ?? '');
const CLAIMS_ENABLED = (process.env.WELES_CLAIMS_ENABLED ?? '1') === '1';
if ((LEASE_DEPLOYMENT_ID && (!Number.isSafeInteger(LEASE_GENERATION) || LEASE_GENERATION < 1))
    || (!LEASE_DEPLOYMENT_ID && process.env.WELES_DEPLOYMENT_GENERATION)) {
  throw new Error('immutable worker lease requires WELES_DEPLOYMENT_ID and a positive WELES_DEPLOYMENT_GENERATION');
}
const ACTION_ALLOWLIST_VALUES = (process.env.WELES_ACTION_ALLOWLIST ?? '')
  .split(',')
  .map((action) => action.trim())
  .filter(Boolean);
if (!ACTION_ALLOWLIST_VALUES.length
    || new Set(ACTION_ALLOWLIST_VALUES).size !== ACTION_ALLOWLIST_VALUES.length
    || ACTION_ALLOWLIST_VALUES.some((action) => !/^[a-z_]+$/.test(action))) {
  throw new Error('WELES_ACTION_ALLOWLIST must contain unique exact lowercase Weles action names');
}
const ACTION_ALLOWLIST = new Set(ACTION_ALLOWLIST_VALUES);

// Why any of this exists: a placement policy that excludes every allowlisted
// action is a decision the control plane made about this host, and a decision
// that leaves no record is indistinguishable from an empty queue — both look
// like an idle poll. That ambiguity is how charless-mac-mini sat claiming
// nothing for twelve days without anyone noticing. So every path that ends in
// "this host deliberately claimed nothing" says so, in the same voice as the
// diagnostics gate in poll.ts. The poll loop runs forever, so an unchanged
// reason is reported once and then only when it changes or the cooldown
// elapses; the point is a visible standing condition, not a log flood.
const DENIAL_REPORT_COOLDOWN_MS = 5 * 60_000;
const DENIAL_EXAMPLE_ACTIONS = 3;
let lastDenial: { reason: string; at: number } | null = null;

export function reportClaimDenial(reason: string): void {
  const now = Date.now();
  if (lastDenial && lastDenial.reason === reason && now - lastDenial.at < DENIAL_REPORT_COOLDOWN_MS) return;
  lastDenial = { reason, at: now };
  console.error(`[worker] claiming nothing — ${reason}`);
}

function exampleActions(actions: Iterable<string>): string {
  const all = [...actions];
  if (!all.length) return 'none';
  const shown = all.slice(0, DENIAL_EXAMPLE_ACTIONS);
  return shown.join(', ') + (all.length > shown.length ? `, +${all.length - shown.length} more` : '');
}

export async function claimOne(policy: WelesActionPolicy): Promise<ActionLogRow | null> {
  if (!CLAIMS_ENABLED) {
    reportClaimDenial('claims are disabled on this host by the launcher (WELES_CLAIMS_ENABLED=0)');
    return null;
  }
  if (!policy.enabled) {
    reportClaimDenial('the host placement policy is disabled for this host, so no queued row is eligible');
    return null;
  }
  if (policy.actions.length === 0) {
    reportClaimDenial(`the host placement policy lists 0 actions for this host; the launcher allowlist has ${ACTION_ALLOWLIST.size} (${exampleActions(ACTION_ALLOWLIST)}). This host is configured to claim nothing.`);
    return null;
  }
  // The launcher allowlist is the hard bound on what this binary may ever run;
  // the host placement policy narrows it further, and a wildcard host policy
  // claims the whole allowlist.
  const allowedActions = policy.wildcard
    ? ACTION_ALLOWLIST
    : new Set(policy.actions.filter((action) => ACTION_ALLOWLIST.has(action)));
  if (allowedActions.size === 0) {
    reportClaimDenial(`the host placement policy and the launcher allowlist do not intersect — policy lists ${policy.actions.length} action(s) (${exampleActions(policy.actions)}), allowlist has ${ACTION_ALLOWLIST.size} (${exampleActions(ACTION_ALLOWLIST)}). This host is configured to claim nothing, which is not the same as an empty queue.`);
    return null;
  }
  const actionFilter = `&action=in.(${[...allowedActions].map((action) =>
    encodeURIComponent(`"${action.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',')})`;
  // Lookahead 1000 rows so large legacy backlogs don't hide fresh trading
  // scrape rows behind the first page. Keep the SELECT schema-minimal:
  // Echo's account_action_logs currently has no webhook_url,
  // cancel_requested, or priority columns; selecting them makes PostgREST
  // return 400 and the worker appear idle forever.
  const res = await fetch(
    `${DATABASE_URL}/rest/v1/account_action_logs?select=id,account_id,action,platform,params,status&status=eq.queued&or=(scheduled_at.is.null,scheduled_at.lte.now())${actionFilter}&order=scheduled_at.asc.nullsfirst&limit=1000`,
    { headers: headers() },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[worker] claim candidate query failed ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }
  // Tally, never per-row logging: one poll can look at a thousand rows and the
  // operator only needs to know that all of them were dropped and by which rule.
  const dropped = new Map<string, number>();
  const drop = (reason: string) => { dropped.set(reason, (dropped.get(reason) ?? 0) + 1); };
  let candidates = ((await res.json()) as ActionLogRow[])
    .filter((row) => {
      if (allowedActions.has(row.action)) return true;
      drop('outside this host\'s allowed actions');
      return false;
    });
  // Priority sort: trading scrapes first, then recovery rows (*_login,
  // *_register, *_health, *_balance, *_topup), then everything else.
  // Scrapes are parallel-safe direct jobs and must not be buried behind a
  // legacy social recovery backlog; login still beats ordinary social rows.
  const recoveryRe = /_(login|register|health|balance|topup|reauth)$/;
  const isParallelSafeScrape = (a: string) => /^(unusualwhales|volumeleaders|tradingview)_scrape$/.test(a);
  const priority = (row: ActionLogRow) => (isParallelSafeScrape(row.action) ? 2000 : 0) + (recoveryRe.test(row.action) ? 1000 : 0) + Number(row.priority ?? 0);
  candidates = candidates
    .map((r, i) => ({ r, i, p: priority(r) }))
    .sort((x, y) => y.p - x.p || x.i - y.i)
    .map((e) => e.r);
  const executionHost = os.hostname();
  const executionAgent = process.env.WELES_EXECUTION_AGENT ?? 'weles-worker';
  candidates = candidates.filter((row) => {
    if (row.action !== 'apple_login') return true;
    const params = row.params && typeof row.params === 'object' && !Array.isArray(row.params)
      ? row.params as Record<string, unknown>
      : {};
    if (params.apple_execution_host === executionHost
      && params.apple_execution_agent === executionAgent) return true;
    drop('apple_login pinned to another execution host');
    return false;
  });
  // Per-account in-flight lock: each account has ONE stored sticky proxy session (Oxylabs sessid). Concurrent connections to one sticky session get refused with ERR_TUNNEL_CONNECTION_FAILED. Serialize per-account; deferred rows pick up next tick. Ignore rows older than 30 min — those are stuck-poison from killed workers and should not block their account forever.
  const inflightAccounts = new Set<string>();
  if (candidates.length) {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await fetch(`${DATABASE_URL}/rest/v1/account_action_logs?select=account_id,claimed_at&status=eq.running&claimed_at=gte.${cutoff}`, { headers: headers() });
    if (r.ok) for (const row of (await r.json()) as { account_id: string | null }[]) if (row.account_id) inflightAccounts.add(row.account_id);
  }
  const staleAccounts = await staleCookieAccounts(candidates);
  // Trading scrapes run with proxy_url_override='direct' (no sticky-session
  // proxy), so the per-account in-flight lock that protects Oxylabs sessids
  // does not apply. Allowing N workers to claim concurrent *_scrape rows
  // for the same sentinel account is what makes parallel trading scrapes
  // possible. Social actions still get the lock because they share an
  // Oxylabs sticky session per account.
  // Account-less actions the worker may claim: direct trading scrapes (the
  // scripts use ticker/page params, not ACCOUNT_ID), account creation, proxy
  // provider balance/topup, and infra maintenance (resend_verify_domain_status
  // health check + the slack_post_message alert it chains), plus analytics
  // service browser actions that use service credentials rather than a social
  // account row. Everything else without an account is a poison orphan.
  const isOverleafAction = (a: string) => a.startsWith('overleaf_');
  const canRunWithoutAccount = (a: string) => isParallelSafeScrape(a) || /_register$|_balance$|_topup$|_reauth$|_verify_domain_status$|_post_message$/.test(a) || a === 'slack_provision_user_token' || a === 'pangram_analyze_text' || a === 'ncbr_pangram_audit_new_wniosek' || a === 'generic_browser_task' || a === 'generic_keeper_task' || a === 'generic_saved_task' || a === 'semanticscholar_key_followup' || isOverleafAction(a) || /^(umami|googleanalytics)_/.test(a);
  for (const row of candidates) {
    // Defend independently of PostgREST decoding/filter semantics.
    if (!allowedActions.has(row.action)) { drop('outside this host\'s allowed actions'); continue; }
    if (!resolveTrajectory(row.action)) { drop('no dispatch route for the action'); continue; }
    if (!row.id) { drop('row has no id'); continue; }
    if (!row.account_id && !canRunWithoutAccount(row.action)) { drop('no account on an action that needs one'); continue; } // poison rows: legacy promote-cron sometimes emits orphans
    if (row.account_id && inflightAccounts.has(row.account_id) && !isParallelSafeScrape(row.action)) { drop('account already in flight'); continue; }
    // staleAccounts blocks non-recovery actions; recovery actions (login,
    // register, health, balance, topup) MUST run to refresh stale cookies
    // — without this carve-out, _login rows for stale accounts get blocked
    // by the same flag they exist to clear, and the account stays dead.
    // (Same intent as the filter at stale.ts:31, applied per-row here.)
    if (row.account_id && staleAccounts.has(row.account_id) && !recoveryRe.test(row.action) && !isParallelSafeScrape(row.action)) { drop('cookie-stale account'); continue; }

    const claim = await fetch(
      `${DATABASE_URL}/rest/v1/account_action_logs?id=eq.${row.id}&status=eq.queued`,
      {
        method: 'PATCH',
        headers: { ...headers(), Prefer: 'return=representation' },
        body: JSON.stringify({
          status: 'running',
          claimed_by: INSTANCE_ID,
          claimed_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          ...(LEASE_DEPLOYMENT_ID ? {
            lease_deployment_id: LEASE_DEPLOYMENT_ID,
            lease_generation: LEASE_GENERATION,
          } : {}),
        }),
      },
    );
    if (!claim.ok) { drop(`claim PATCH rejected (${claim.status})`); continue; }
    const claimed = (await claim.json()) as ActionLogRow[];
    if (claimed.length > 0) return claimed[0];
    drop('lost the claim race to another worker');
  }
  if (dropped.size) {
    const detail = [...dropped].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${count} ${reason}`).join(', ');
    reportClaimDenial(`every queued candidate was filtered out — ${detail}`);
  }
  return null;
}
