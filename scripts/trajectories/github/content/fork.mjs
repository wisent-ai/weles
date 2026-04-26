import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

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
  await s.page.waitForTimeout(3500);
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

  const goal = `You are on GitHub's create-fork page for ${upstreamPath}. Leave the default owner and repository name. Find the green "Create fork" button at the bottom of the form and click it. done(value="fork_clicked"). Do NOT navigate() and do NOT change any form fields.`;
  await execute(s, goal, { flowName: 'github_fork' });

  for (let w = 0; w < 30; w++) {
    await s.page.waitForTimeout(1000);
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
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'github_fork'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_fork', upstream: upstreamPath, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
