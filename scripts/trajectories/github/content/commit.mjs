import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';

const REPO_URL = process.env.REPO_URL || '';
const FILE_PATH = process.env.FILE_PATH || 'README.md';
const COMMIT_MESSAGE = (process.env.COMMIT_MESSAGE || 'update notes').slice(0, 200);
const FILE_APPEND = process.env.FILE_APPEND || `\n- ${new Date().toISOString().slice(0, 10)}: quick note\n`;

function normalize(raw) {
  if (!raw) return '';
  if (raw.startsWith('http')) return raw.replace(/\/$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  return '';
}
const repoBase = normalize(REPO_URL);
if (!repoBase) { console.log('FAIL: REPO_URL required for commit'); process.exit(1); }

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'github_commit', proxy: proxyUrl, persona });
let ban = null;
try {
  const cookies = (acct.metadata?.cookies ?? []).filter(c => (c.domain ?? '').includes('github.com'));
  if (cookies.length) await s.ctx.addCookies(cookies).catch(() => {});
  await s.goto(`${repoBase}/edit/main/${FILE_PATH}`);
  checkReachable(s, 'github');
  await humanIdlePause('long');
  const loggedOut = await s.page.evaluate(() => !!document.querySelector('a[href="/login"]'));
  if (loggedOut) throw new Error('not_logged_in: cookies stale');
  const is404 = await s.page.evaluate(() => /page not found/i.test(document.body.innerText || ''));
  if (is404) throw new Error(`repo_or_file_404: url=${s.page.url?.() ?? ''}`);

  // Programmatic CodeMirror append: click the editor, send End+Enter via
  // keyboard, type the line. Direct DOM manipulation on CodeMirror would
  // bypass GitHub's diff-tracking, so we stay with keyboard events.
  await humanClickLocator(s.page, s.page.locator('.CodeMirror, [data-codemirror], textarea[name="value"], div[contenteditable="true"]').first()).catch(() => {});
  await s.page.keyboard.press('End').catch(() => {});
  await s.page.keyboard.press('Enter').catch(() => {});
  await humanType(s.page, FILE_APPEND.trim()).catch(() => {});
  await humanIdlePause('short');

  // Open the Commit-changes modal: toolbar button text is "Commit changes...".
  // GitHub's React editor renders it as <button> with primary styling.
  const openCommit = s.page.locator('button:has-text("Commit changes")').filter({ visible: true }).first();
  await openCommit.waitFor({ state: 'visible', timeout: 10000 });
  await humanClickLocator(s.page, openCommit);
  await humanIdlePause('deliberate');
  // Modal commit message textarea — id="commit-message-input" / aria-label="Commit message".
  const msgIn = s.page.locator('textarea[id="commit-message-input"], textarea[aria-label*="ommit message"], dialog textarea[name="commit_message"]').filter({ visible: true }).first();
  if (await msgIn.count()) {
    await humanClickLocator(s.page, msgIn);
    await s.page.keyboard.press('Control+A').catch(() => {});
    await s.page.keyboard.press('Meta+A').catch(() => {});
    await s.page.keyboard.press('Delete').catch(() => {});
    await humanType(s.page, COMMIT_MESSAGE);
  }
  await humanIdlePause('short');
  // Modal confirm button — second "Commit changes" inside dialog/Box--overlay.
  const confirmCommit = s.page.locator('dialog button:has-text("Commit changes"), [role="dialog"] button:has-text("Commit changes"), .Box--overlay button:has-text("Commit changes")').filter({ visible: true }).first();
  await confirmCommit.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, confirmCommit);

  for (let w = 0; w < 20; w++) {
    await humanIdlePause('short');
    const u = s.page.url?.() ?? '';
    if (/\/(blob|commit|tree)\//.test(u) && !/\/edit\//.test(u)) break;
  }
  const finalUrl = s.page.url?.() ?? '';
  if (/\/edit\//.test(finalUrl)) throw new Error(`commit_not_applied: still at ${finalUrl}`);
  ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: committed to ${repoBase}/${FILE_PATH}`);
} catch (e) {
  ban = e.banSignal ?? await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'github_commit'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_commit', repo_url: repoBase, file_path: FILE_PATH, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
