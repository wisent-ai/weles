/**
 * Shared health-probe runner. Each platform supplies a config with:
 *   platform:            string — 'reddit' | 'twitter' | etc
 *   loggedInUrl:         string | (username) => string — absolute URL; captured response body parsed
 *   loggedInRegex:       RegExp — matches captured response URL to extract the body
 *   loggedOutUrl:        (username) => string — absolute URL; 200 vs 404 determines shadowban
 *   loggedOutRegex:      RegExp — matches captured response URL
 *   banDetector:         async (page, responses) => BanSignal
 *   extractLoggedIn:     (body) => { ok, karma, is_suspended } — from parsed JSON or HTML
 *
 * Writes recordings/<platform>_health/<username>_<ts>.json.
 */
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export async function runHealthProbe(cfg) {
  const acct = await getSocialAccount(cfg.platform);
  if (!acct) { console.log(`FAIL: no active ${cfg.platform} account`); process.exit(1); }
  console.log(`[health:${cfg.platform}] acct=${acct.username}`);
  const { proxyUrl, persona } = await resolveAccountSession(acct);

  const loggedIn = { url: null, status: null, body: null, signal: null };
  const sIn = await WSession.start({ label: `${cfg.platform}_health_in`, proxy: proxyUrl, persona });
  try {
    // Inject stored auth cookies so the "logged in" probe actually is authed.
    // Without these the authed API endpoints 401 / redirect to authwall and
    // every health probe reports 'unknown' even on a healthy account.
    const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
    const prepared = stored.filter((c) => c && c.name && c.value && (c.domain || c.url)).map((c) => ({ ...c, path: c.path || '/' }));
    if (prepared.length > 0) await sIn.ctx.addCookies(prepared).catch(() => {});
    const inUrl = typeof cfg.loggedInUrl === 'function' ? cfg.loggedInUrl(acct.username) : cfg.loggedInUrl;
    await sIn.goto(inUrl);
    const resp = sIn.capturedResponses.find(r => cfg.loggedInRegex.test(r.url));
    if (resp) {
      loggedIn.url = resp.url; loggedIn.status = resp.status;
      try { loggedIn.body = JSON.parse(resp.body); } catch { loggedIn.body = resp.body?.slice(0, 2000) ?? null; }
    }
    loggedIn.signal = await cfg.banDetector(sIn.page, sIn.capturedResponses).catch(() => null);
  } catch (e) {
    loggedIn.error = e.message?.slice(0, 200);
  } finally {
    await sIn.close();
  }

  const loggedOut = { url: null, status: null, body: null };
  if (cfg.loggedOutUrl) {
    const sOut = await WSession.start({ label: `${cfg.platform}_health_out`, proxy: proxyUrl });
    try {
      await sOut.goto(cfg.loggedOutUrl(acct.username));
      const resp = sOut.capturedResponses.find(r => cfg.loggedOutRegex.test(r.url));
      if (resp) {
        loggedOut.url = resp.url; loggedOut.status = resp.status;
        try { loggedOut.body = JSON.parse(resp.body); } catch { loggedOut.body = resp.body?.slice(0, 2000) ?? null; }
      }
    } catch (e) {
      loggedOut.error = e.message?.slice(0, 200);
    } finally {
      await sOut.close();
    }
  }

  const extracted = cfg.extractLoggedIn?.(loggedIn.body, loggedIn) ?? { ok: !!loggedIn.body, karma: null, is_suspended: false };
  const outOk = cfg.extractLoggedOut
    ? cfg.extractLoggedOut(loggedOut)
    : (loggedOut.status === 200);
  const shadowbanned = extracted.ok && !outOk && (loggedOut.status === 404 || loggedOut.status == null);

  let signal;
  if (extracted.is_suspended) signal = 'suspended';
  else if (!extracted.ok && loggedIn.signal?.signal && loggedIn.signal.signal !== 'healthy') signal = loggedIn.signal.signal;
  else if (shadowbanned) signal = 'shadowbanned';
  else if (extracted.ok && outOk) signal = 'healthy';
  else signal = 'unknown';

  const snapshot = {
    account_id: acct.id, username: acct.username, platform: cfg.platform,
    checked_at: new Date().toISOString(),
    signal, shadowbanned, is_suspended: extracted.is_suspended, karma: extracted.karma,
    logged_in: loggedIn, logged_out: loggedOut,
  };
  const outDir = join(process.cwd(), 'recordings', `${cfg.platform}_health`);
  mkdirSync(outDir, { recursive: true });
  const filePath = join(outDir, `${acct.username}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  console.log(`[health:${cfg.platform}] signal=${signal} karma=${extracted.karma} shadowbanned=${shadowbanned}`);
  console.log(`[health:${cfg.platform}] snapshot -> ${filePath}`);
  // Exit 0 whenever we probed successfully and have an actionable signal —
  // even 'suspended' / 'shadowbanned' / 'ip_blocked' are valid probe outcomes
  // the dashboard needs as completed+signaled rows, not as 'failed'. Only
  // exit 2 when the probe itself couldn't determine state.
  if (signal === 'unknown') process.exitCode = 2;
  return snapshot;
}
