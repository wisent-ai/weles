import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

const REPO_URL = process.env.REPO_URL || '';
function normalize(raw) {
  if (!raw) return '';
  if (raw.startsWith('http')) return raw.replace(/\/$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  return '';
}
const upstream = normalize(REPO_URL);
if (!upstream) { console.log('FAIL: REPO_URL required for fork'); process.exit(1); }
const upstreamPath = upstream.replace(/^https:\/\/github\.com\//, '');

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'github_fork', proxy: proxyUrl, persona });
let ban = null;
try {
  const cookies = (acct.metadata?.cookies ?? []).filter(c => (c.domain ?? '').includes('github.com'));
  if (cookies.length) await s.ctx.addCookies(cookies).catch(() => {});
  await s.goto(`${upstream}/fork`);
  checkReachable(s, 'github');
  await humanIdlePause('deliberate');
  const loggedOut = await s.page.evaluate(() => !!document.querySelector('a[href="/login"]'));
  if (loggedOut) throw new Error('not_logged_in: cookies stale');

  const alreadyForked = await s.page.evaluate((user) => {
    return (document.body.innerText || '').includes(`You've already forked`) ||
           (document.body.innerText || '').toLowerCase().includes(`you already have a fork`);
  }, acct.username);
  if (alreadyForked) {
    console.log('[fork] already forked this repo — skipping with success');
    ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already_forked ${upstreamPath}`);
    await s.close();
    process.exit(0);
  }

  // The /fork route renders a form with one submit button — green "Create fork".
  // GitHub uses <button type="submit"> within the wrapping <form action="/<owner>/<repo>/fork">.
  const submitBtn = s.page.locator('form[action$="/fork"] button[type="submit"], button[type="submit"]:has-text("Create fork")').filter({ visible: true }).first();
  await submitBtn.waitFor({ state: 'visible' });
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await humanClickLocator(s.page, submitBtn);

  for (let w = 0; w < 30; w++) {
    await humanIdlePause('short');
    const u = s.page.url?.() ?? '';
    if (new RegExp(`github\\.com/${acct.username}/`).test(u) && !/\/fork/.test(u)) break;
  }
  const finalUrl = s.page.url?.() ?? '';
  if (!new RegExp(`github\\.com/${acct.username}/`).test(finalUrl) || /\/fork/.test(finalUrl)) {
    throw new Error(`fork_not_created: final url=${finalUrl}`);
  }
  ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: forked ${upstreamPath} -> ${finalUrl}`);
} catch (e) {
  ban = e.banSignal ?? await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = runRecordingsDir('github_fork'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_fork', upstream: upstreamPath, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
