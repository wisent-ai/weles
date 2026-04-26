import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const REPO_URL = process.env.REPO_URL || '';
const ISSUE_TITLE = (process.env.ISSUE_TITLE || 'question about usage').slice(0, 250);
const ISSUE_BODY = (process.env.ISSUE_BODY || 'Hi! Following this project. Curious about the roadmap — is there a recommended way to get started?').slice(0, 4000);

function normalize(raw) {
  if (!raw) return '';
  if (raw.startsWith('http')) return raw.replace(/\/$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  return '';
}
const repoBase = normalize(REPO_URL);
if (!repoBase) { console.log('FAIL: REPO_URL required for open_issue'); process.exit(1); }

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'github_open_issue', proxy: proxyUrl, persona });
let ban = null;
try {
  const cookies = (acct.metadata?.cookies ?? []).filter(c => (c.domain ?? '').includes('github.com'));
  if (cookies.length) await s.ctx.addCookies(cookies).catch(() => {});
  await s.goto(`${repoBase}/issues/new/choose`);
  checkReachable(s, 'github');
  await s.page.waitForTimeout(3500);
  const loggedOut = await s.page.evaluate(() => !!document.querySelector('a[href="/login"]'));
  if (loggedOut) throw new Error('not_logged_in: cookies stale');

  // Template picker — click "Open a blank issue" if present. GitHub renders it
  // as an <a> with text "Open a blank issue". If repo has no templates
  // /issues/new/choose 302s to /issues/new and we're already on the form.
  // Use Playwright locator click so the event hits github's spam ML with
  // isTrusted=true (see docs/DETECTION_ANTIPATTERNS.md §1).
  const blankLoc = s.page.locator('a:has-text("Open a blank issue")').first();
  const hasBlank = (await blankLoc.count()) > 0;
  if (hasBlank) await blankLoc.click().catch(() => {});
  const blankClicked = { clicked: hasBlank, onForm: !!(await s.page.locator('input[name="issue[title]"]').count()) };
  console.log(`[open_issue] blank_picker: ${JSON.stringify(blankClicked)}`);
  await s.page.waitForTimeout(3000);

  const fill = await s.page.evaluate((data) => {
    const title = document.querySelector('input[name="issue[title]"], input#issue_title');
    const body = document.querySelector('textarea[name="issue[body]"], textarea#issue_body');
    const sText = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const sTextArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    if (!title || !body) return { ok: false, hasTitle: !!title, hasBody: !!body };
    sText.call(title, data.title); title.dispatchEvent(new Event('input', { bubbles: true }));
    sTextArea.call(body, data.body); body.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, titleLen: title.value.length, bodyLen: body.value.length };
  }, { title: ISSUE_TITLE, body: ISSUE_BODY });
  console.log(`[open_issue] fill: ${JSON.stringify(fill)}`);
  await s.page.waitForTimeout(2000);

  // Title + body were already filled programmatically above. Ask the agent only
  // to click the submit button — explicit selector to avoid vision-based misses
  // on GitHub's evolving form UI (the green button has both text variants:
  // "Submit new issue" on classic and "Create" on the React-rewrite).
  const goal = `You are on GitHub's new-issue form for the repo. The title and body are already filled. Use js_click(selector="button[type='submit']:has-text('Submit new issue'), button[type='submit']:has-text('Create'), button.btn-primary[type='submit']") to submit. Wait 5 seconds. done(value="submitted"). Do NOT navigate() manually. Do not refill any text.`;
  await execute(s, goal, {}); // flow cache would freeze literal ISSUE_TITLE/ISSUE_BODY; always replan

  for (let w = 0; w < 20; w++) {
    await s.page.waitForTimeout(1000);
    const u = s.page.url?.() ?? '';
    if (/\/issues\/\d+/.test(u)) break;
  }
  const finalUrl = s.page.url?.() ?? '';
  if (!/\/issues\/\d+/.test(finalUrl)) throw new Error(`issue_not_submitted: final url=${finalUrl}`);
  ban = await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: opened ${finalUrl}`);
} catch (e) {
  ban = e.banSignal ?? await detectGitHubBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'github_open_issue'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_open_issue', repo_url: repoBase, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
