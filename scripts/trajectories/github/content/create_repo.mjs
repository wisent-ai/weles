import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Word pool used to generate organic-looking repo names when REPO_NAME isn't
// supplied. Set WELES_GITHUB_REPO_WORDS to override (comma-separated) so the
// orchestrator can diversify the pool without touching trajectory code.
const WORD_POOL = (process.env.WELES_GITHUB_REPO_WORDS ?? 'notes,scratch,dotfiles,playground,sandbox,learning,snippets,configs,bits,practice').split(',');
function slug() {
  const w = WORD_POOL[Math.floor(Math.random() * WORD_POOL.length)].trim() || 'scratch';
  return `${w}-${randomBytes(3).toString('hex')}`;
}

const REPO_NAME = (process.env.REPO_NAME || slug()).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 90);
const REPO_DESC = (process.env.REPO_DESC || 'personal workspace').slice(0, 300);

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'github_create_repo', proxy: proxyUrl, persona });
let ban = null;
try {
  const cookies = (acct.metadata?.cookies ?? []).filter(c => (c.domain ?? '').includes('github.com'));
  if (cookies.length) await s.ctx.addCookies(cookies).catch(() => {});
  await s.goto('https://github.com/new');
  await s.page.waitForTimeout(3000);
  const loggedOut = await s.page.evaluate(() => !!document.querySelector('a[href="/login"]'));
  if (loggedOut) throw new Error('not_logged_in: cookies stale');

  const prefill = await s.page.evaluate((data) => {
    const name = document.querySelector('input[name="repository[name]"], input#repository_name');
    const desc = document.querySelector('input[name="repository[description]"], input#repository_description');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    if (!name) return { ok: false, reason: 'no_name_input' };
    setter.call(name, data.name); name.dispatchEvent(new Event('input', { bubbles: true }));
    if (desc) { setter.call(desc, data.desc); desc.dispatchEvent(new Event('input', { bubbles: true })); }
    const readme = document.querySelector('input[name="repository[auto_init]"], input#repository_auto_init');
    if (readme && !readme.checked) readme.click();
    return { ok: true, name: name.value, hasDesc: !!desc };
  }, { name: REPO_NAME, desc: REPO_DESC });
  console.log(`[create_repo] prefill: ${JSON.stringify(prefill)}`);
  await s.page.waitForTimeout(2000);

  const goal = `You are on GitHub's new-repository form. The name "${REPO_NAME}", description, and Add-a-README checkbox are already filled in. Scroll to the bottom if needed and click the green "Create repository" button. done(value="create_clicked"). Do NOT navigate() and do NOT modify the filled fields.`;
  await execute(s, goal, { flowName: 'github_create_repo' });

  for (let w = 0; w < 15; w++) {
    await s.page.waitForTimeout(1000);
    const u = s.page.url?.() ?? '';
    if (new RegExp(`github\\.com/${acct.username}/${REPO_NAME}(?:/|$)`).test(u)) break;
  }
  const finalUrl = s.page.url?.() ?? '';
  if (!new RegExp(`github\\.com/${acct.username}/${REPO_NAME}(?:/|$)`).test(finalUrl)) {
    throw new Error(`repo_not_created: final url=${finalUrl}`);
  }
  ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: created ${acct.username}/${REPO_NAME}`);
} catch (e) {
  ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'github_create_repo'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_create_repo', repo_name: REPO_NAME, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
