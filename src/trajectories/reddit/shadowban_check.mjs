/**
 * Reddit shadowban ground-truth check trajectory.
 *
 * Runs three independent fetches of /user/<username>/about.json from three
 * fresh proxy sessions (different sticky exit IPs, no cookies). Aggregates
 * the responses into a single verdict ('shadowbanned' | 'healthy' |
 * 'indeterminate') so the verdict is robust to per-IP edge false positives.
 *
 * On 'shadowbanned': PATCHes social_accounts.status='shadowbanned' (per
 * user request — auto-flag pulls the account out of routine rotation).
 *
 * Output: writes recordings/reddit_shadowban_check/<username>_<ts>.json
 * with per-vantage results and the aggregate verdict.
 *
 * Usage:
 *   ACCOUNT_ID=<id> xvfb-run -a node src/trajectories/reddit/shadowban_check.mjs
 */
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { probeShadowban } from '../../../dist/platforms/reddit/shadowban_probe.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { updateAccountMetadata } from '../_shared/skarbiec_accounts.mjs';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }

// Resolve the account's REAL handle from /api/me.json — Reddit auto-assigns
// usernames during signup that may differ from our stored email-prefix.
const { proxyUrl, persona } = await resolveAccountSession(acct);
const sIn = await WSession.start({ label: 'reddit_shadowban_handle_lookup', proxy: proxyUrl, persona, targetHost: 'www.reddit.com' });
let realHandle = acct.username;
try {
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  const prepared = stored.filter((c) => c?.name && c?.value && (c.domain || c.url)).map((c) => ({ ...c, path: c.path || '/' }));
  if (prepared.length > 0) await sIn.ctx.addCookies(prepared).catch(() => {});
  await sIn.goto('https://www.reddit.com/api/me.json');
  const meResp = sIn.capturedResponses.find(r => /\/api\/me\.json/.test(r.url));
  if (meResp?.body) {
    try {
      const j = JSON.parse(meResp.body);
      const h = j?.data?.name ?? j?.name;
      if (typeof h === 'string' && h.length > 0) realHandle = h;
    } catch { /* keep fallback */ }
  }
} catch (e) {
  console.log(`[shadowban_check] handle lookup err: ${e.message?.slice(0, 120)}`);
} finally {
  await sIn.close();
}

console.log(`[shadowban_check] probing realHandle=${realHandle} (stored=${acct.username})`);
const result = await probeShadowban(realHandle, 3);
console.log(`[shadowban_check] verdict=${result.verdict}`);
for (const v of result.vantages) {
  console.log(`[shadowban_check]   vantage=${v.vantage} status=${v.status} hasBody=${v.has_body} exit_ip=${v.exit_ip ?? '?'} err=${v.err ?? ''}`);
}

const dir = runRecordingsDir('reddit_shadowban_check');
mkdirSync(dir, { recursive: true });
const outPath = join(dir, `${acct.username}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify({ account_id: acct.id, username: acct.username, real_handle: realHandle, ...result }, null, 2));
console.log(`[shadowban_check] snapshot -> ${outPath}`);

// Pull shadowbanned accounts from rotation in their Skarbiec record.
if (result.verdict === 'shadowbanned' && acct.id) {
  updateAccountMetadata(acct.id, { status: 'shadowbanned' });
  console.log('[shadowban_check] stored status=shadowbanned in Skarbiec');
}

// Non-zero exit on indeterminate — gives the routine cron a chance to retry.
// 0 on healthy + shadowbanned (both are valid completed-with-verdict states).
if (result.verdict === 'indeterminate') process.exitCode = 2;
