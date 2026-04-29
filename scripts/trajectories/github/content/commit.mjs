import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';

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
  await s.page.waitForTimeout(5000);
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
  await s.page.waitForTimeout(1500);

  // Open the Commit-changes modal via explicit selector — the toolbar button
  // has a distinctive class/data-attr in both classic and React UIs.
  const openModalGoal = `Click the "Commit changes..." button in the toolbar (top right of the editor). Use js_click(selector="button:has-text('Commit changes'):not([disabled]), button.btn-primary:has-text('Commit'), button[data-test-selector*='commit']") to open it. Wait 2 seconds for the modal to render. The modal title is "Commit changes" or "Propose changes". Then in the modal, clear the message field if it's pre-populated and type exactly: ${COMMIT_MESSAGE}. Keep "Commit directly to the main branch" selected. Then use js_click(selector="dialog button:has-text('Commit changes'):not([disabled]), .Box--overlay button.btn-primary:not([disabled])") to confirm. After the modal closes and URL changes from /edit/, done(value="committed"). Do NOT navigate() manually.`;
  await execute(s, openModalGoal, {}); // flow cache would freeze literal COMMIT_MESSAGE; always replan

  for (let w = 0; w < 20; w++) {
    await s.page.waitForTimeout(1000);
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
