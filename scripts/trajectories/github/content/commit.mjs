import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
  await s.page.waitForTimeout(4000);
  const loggedOut = await s.page.evaluate(() => !!document.querySelector('a[href="/login"]'));
  if (loggedOut) throw new Error('not_logged_in: cookies stale');

  const isEditor = await s.page.evaluate(() => !!document.querySelector('.CodeMirror, [role="textbox"][contenteditable], .react-blob-edit-wrapper'));
  if (!isEditor) throw new Error(`editor_not_loaded: url=${s.page.url?.() ?? ''}`);

  const append = await s.page.evaluate((text) => {
    const cm = document.querySelector('.CodeMirror');
    if (cm && cm.CodeMirror) {
      const end = cm.CodeMirror.getValue();
      cm.CodeMirror.setValue(end + text);
      return { via: 'codemirror', len: cm.CodeMirror.getValue().length };
    }
    const ta = document.querySelector('textarea[name="value"], textarea');
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, (ta.value || '') + text); ta.dispatchEvent(new Event('input', { bubbles: true }));
      return { via: 'textarea', len: ta.value.length };
    }
    return { via: 'none' };
  }, FILE_APPEND);
  console.log(`[commit] append: ${JSON.stringify(append)}`);
  await s.page.waitForTimeout(1500);

  const goal = `You are on GitHub's file-edit page for ${FILE_PATH}. The file has been modified in the editor. Find and click the "Commit changes..." button (top right of the editor). In the modal that appears, the commit message input should be visible — clear it if needed and type exactly: ${COMMIT_MESSAGE}. Then click the green "Commit changes" button to confirm. done(value="committed"). Do NOT navigate(). Do NOT change the file content.`;
  await execute(s, goal, { flowName: 'github_commit' });

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
  ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'github_commit'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_commit', repo_url: repoBase, file_path: FILE_PATH, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
