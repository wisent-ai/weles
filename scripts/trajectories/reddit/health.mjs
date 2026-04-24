/**
 * Reddit account health probe. Runs independent of register/login/action flows.
 *
 * Logged-in view: navigate to reddit.com/api/me.json via the account's persona
 *   + proxy + cookies. Captures body to read karma + is_suspended.
 * Logged-out view (shadowban check): SECOND fresh session with the same proxy
 *   pool but no cookies, GET /user/<u>/about.json. If logged-in OK but
 *   logged-out 404s → shadowban.
 */
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { detectRedditBanSignals } from '../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in DB'); process.exit(1); }
console.log(`[health] Probing account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);

const loggedIn = { url: null, status: null, body: null, signal: null };
const sIn = await WSession.start({ label: 'reddit_health_in', proxy: proxyUrl, persona });
try {
  // Inject stored auth cookies so /api/me.json returns the user, not anon.
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  const prepared = stored.filter((c) => c && c.name && c.value && (c.domain || c.url)).map((c) => ({ ...c, path: c.path || '/' }));
  if (prepared.length > 0) await sIn.ctx.addCookies(prepared).catch(() => {});
  await sIn.goto('https://www.reddit.com/api/me.json');
  loggedIn.url = sIn.page.url();
  const meResp = sIn.capturedResponses.find(r => /\/api\/me\.json/.test(r.url));
  if (meResp) {
    loggedIn.status = meResp.status;
    try { loggedIn.body = JSON.parse(meResp.body); } catch { loggedIn.body = meResp.body?.slice(0, 2000) ?? null; }
  }
  loggedIn.signal = await detectRedditBanSignals(sIn.page, sIn.capturedResponses).catch(() => null);
} catch (e) {
  loggedIn.error = e.message?.slice(0, 200);
} finally {
  await sIn.close();
}

const loggedOut = { url: null, status: null, body: null };
const sOut = await WSession.start({ label: 'reddit_health_out', proxy: proxyUrl });
try {
  await sOut.goto(`https://www.reddit.com/user/${encodeURIComponent(acct.username)}/about.json`);
  loggedOut.url = sOut.page.url();
  const aboutResp = sOut.capturedResponses.find(r => /\/user\/.+\/about\.json/.test(r.url));
  if (aboutResp) {
    loggedOut.status = aboutResp.status;
    try { loggedOut.body = JSON.parse(aboutResp.body); } catch { loggedOut.body = aboutResp.body?.slice(0, 2000) ?? null; }
  }
} catch (e) {
  loggedOut.error = e.message?.slice(0, 200);
} finally {
  await sOut.close();
}

const inOk = loggedIn.body?.data?.name === acct.username || loggedIn.body?.name === acct.username;
const inKarma = loggedIn.body?.data?.total_karma ?? loggedIn.body?.data?.link_karma ?? null;
const inSuspended = loggedIn.body?.data?.is_suspended === true || loggedIn.body?.is_suspended === true;
const outOk = loggedOut.status === 200 && (loggedOut.body?.data?.name === acct.username);
const shadowbanned = inOk && !outOk && loggedOut.status === 404;

let signal;
if (inSuspended) signal = 'suspended';
else if (!inOk && loggedIn.signal?.signal && loggedIn.signal.signal !== 'healthy') signal = loggedIn.signal.signal;
else if (shadowbanned) signal = 'shadowbanned';
else if (inOk && outOk) signal = 'healthy';
else signal = 'unknown';

const snapshot = {
  account_id: acct.id,
  username: acct.username,
  checked_at: new Date().toISOString(),
  signal,
  shadowbanned,
  karma: inKarma,
  is_suspended: inSuspended,
  logged_in: loggedIn,
  logged_out: loggedOut,
};

const outDir = join(process.cwd(), 'recordings', 'reddit_health');
mkdirSync(outDir, { recursive: true });
const filePath = join(outDir, `${acct.username}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(filePath, JSON.stringify(snapshot, null, 2));

console.log(`[health] signal=${signal} karma=${inKarma} shadowbanned=${shadowbanned}`);
console.log(`[health] snapshot -> ${filePath}`);
if (signal !== 'healthy') process.exitCode = 2;
