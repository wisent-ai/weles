import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';

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
  if (hasBlank) await humanClickLocator(s.page, blankLoc).catch(() => {});
  const blankClicked = { clicked: hasBlank, onForm: !!(await s.page.locator('input[name="issue[title]"]').count()) };
  console.log(`[open_issue] blank_picker: ${JSON.stringify(blankClicked)}`);
  await s.page.waitForTimeout(3000);

  // Humanized title+body fill — bare descriptor.set + dispatch('input')
  // bypassed all keystrokes which github's spam-ML reads.
  const titleLoc = s.page.locator('input[name="issue[title]"], input#issue_title, input[aria-label="Add a title"], input[placeholder="Title"]').filter({ visible: true }).first();
  const bodyLoc = s.page.locator('textarea[name="issue[body]"], textarea#issue_body, textarea[name="description"], textarea[aria-label="Markdown value"], textarea[placeholder*="description"]').filter({ visible: true }).first();
  const hasTitle = await titleLoc.count();
  const hasBody = await bodyLoc.count();
  if (!hasTitle || !hasBody) {
    console.log(`[open_issue] fill: ${JSON.stringify({ ok: false, hasTitle, hasBody })}`);
    throw new Error('issue_form_not_found');
  }
  await humanFill(s.page, titleLoc, ISSUE_TITLE);
  await humanFill(s.page, bodyLoc, ISSUE_BODY);
  console.log(`[open_issue] fill: ok title=${ISSUE_TITLE.length}c body=${ISSUE_BODY.length}c`);
  await s.page.waitForTimeout(2000);

  // Submit. New issue form has data-testid="create-issue-button"; classic UI
  // uses <button type="submit"> with text "Submit new issue".
  const submitBtn = s.page.locator('[data-testid="create-issue-button"]:not([disabled]), button[type="submit"]:has-text("Submit new issue"), button[type="submit"]:has-text("Create"), button.btn-primary[type="submit"]:not([disabled])').filter({ visible: true }).first();
  await submitBtn.waitFor({ state: 'visible' });
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await humanClickLocator(s.page, submitBtn);

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
