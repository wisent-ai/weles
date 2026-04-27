import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const REPO_URL_RAW = process.env.REPO_URL || process.env.TARGET_URL || '';
const SEARCH_QUERY = process.env.SEARCH_QUERY || '';

function normalizeRepo(raw) {
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  return '';
}
const repoUrl = normalizeRepo(REPO_URL_RAW);

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'github_watch_repo', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /github\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  let url;
  if (repoUrl) url = repoUrl;
  else if (SEARCH_QUERY) url = `https://github.com/search?q=${encodeURIComponent(SEARCH_QUERY)}&type=repositories&s=stars&o=desc`;
  else url = 'https://github.com/trending';
  await s.goto(url);
  checkReachable(s, 'github');
  await s.page.waitForTimeout(2500);
  const goal = repoUrl
    ? `You are on a GitHub repo page. Find the "Watch" dropdown near the top-right (next to Star and Fork). Click it. Click "All Activity" or "Participating and @mentions". done(value="watching"). Do NOT navigate(). Do NOT give_up.`
    : `You are on a GitHub trending or search page. Click the first repo title to open it. Then find the "Watch" dropdown near the top-right and click it. Click "All Activity". done(value="watching"). Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'github_watch_repo' });
  ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'github_watch_repo'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_watch_repo', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
