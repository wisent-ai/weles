// Supabase dashboard project lister.
//
// Logs in with email+password, navigates to /dashboard/projects, scrapes
// every project card and prints { name, ref, org, status, region } as JSON.
// Project refs are 20-char lowercase strings in the URL path
// /project/<ref> (e.g. yqizdfkfnmhddfemdxtq).
//
// Run: node scripts/trajectories/supabase/list_projects.mjs
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const SIGNIN_URL = 'https://supabase.com/dashboard/sign-in';
const PROJECTS_URL = 'https://supabase.com/dashboard/projects';
const DISPLAY_NAME = 'Supabase';
const PROJECT_REF_RE = /^[a-z]{20}$/;

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) { console.log(`FAIL: no '${DISPLAY_NAME}' row in service_credentials`); process.exit(1); }
console.log(`[trajectory] Using service login: ${login.email}`);

const s = await WSession.start({ label: 'supabase_list_projects', browser: 'chromium' });
try {
  await s.goto(SIGNIN_URL);
  await humanIdlePause('deliberate');

  // If we already have a session cookie, sign-in redirects away on its own.
  if (!/\/dashboard\/sign-in/.test(s.page.url())) {
    console.log(`[trajectory] already authenticated, skipping login (url=${s.page.url()})`);
  } else {
    const emailInput = s.page.locator('input[name="email"], input[type="email"], input#email').filter({ visible: true }).first();
    const pwInput = s.page.locator('input[name="password"], input[type="password"], input#password').filter({ visible: true }).first();
    if (!(await emailInput.isVisible().catch(() => false)) || !(await pwInput.isVisible().catch(() => false))) {
      console.log('FAIL: email/password inputs not visible (account may be GitHub-SSO-only)');
      process.exit(1);
    }
    await humanFill(s.page, emailInput, login.email);
    await humanIdlePause('short');
    await humanFill(s.page, pwInput, login.password);
    await humanIdlePause('short');
    const submitBtn = s.page.locator('button[type="submit"]:has-text("Sign In"), button[type="submit"]:has-text("Sign in"), button:has-text("Sign in"), button:has-text("Sign In")').filter({ visible: true }).first();
    if (await submitBtn.isVisible().catch(() => false)) { try { await humanClickLocator(s.page, submitBtn); } catch { /* form may have submitted */ } }
    else { console.log('FAIL: submit button not visible'); process.exit(1); }
    let landed = false;
    for (let i = 0; i < 30; i++) {
      await humanIdlePause('short');
      if (!/\/dashboard\/sign-in/.test(s.page.url())) { landed = true; break; }
    }
    if (!landed) { console.log(`FAIL: stuck on /sign-in after 30s url=${s.page.url()}`); process.exit(1); }
  }

  await s.page.goto(PROJECTS_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');

  const projects = await s.page.evaluate((PROJECT_REF_PATTERN) => {
    const refRe = new RegExp(PROJECT_REF_PATTERN);
    const out = new Map();
    // Pattern A: anchors to /project/<ref> or /dashboard/project/<ref>.
    for (const a of document.querySelectorAll('a[href*="/project/"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/project\/([^/?#]+)/);
      if (!m) continue;
      const ref = m[1];
      if (!refRe.test(ref)) continue;
      const card = a.closest('[role="row"]') || a.closest('li') || a.closest('article') || a.closest('div');
      const cardText = (card?.textContent || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      // Project name is usually the largest text inside the card. Heuristic:
      // pick the first <h1>/<h2>/<h3>/[role=heading] text we find inside the
      // card, falling back to the anchor text itself.
      let name = '';
      if (card) {
        const heading = card.querySelector('h1, h2, h3, h4, [role="heading"]');
        if (heading?.textContent?.trim()) name = heading.textContent.trim();
      }
      if (!name) name = (a.textContent || '').trim().split('\n')[0]?.slice(0, 80) ?? '';
      // Region / status badges typically have data-state, data-status, or
      // a tailwind-style "uppercase" class. Best effort.
      const regionMatch = cardText.match(/\b(us|eu|ap|sa|ca)-(?:east|west|central|north|south|southeast|northeast)-\d\b/i);
      const statusMatch = cardText.match(/\b(ACTIVE_HEALTHY|ACTIVE|INACTIVE|PAUSED|COMING_UP|GOING_DOWN|REMOVED|RESTORING|UNKNOWN)\b/);
      if (!out.has(ref)) {
        out.set(ref, {
          ref,
          name: name || '(unknown)',
          region: regionMatch ? regionMatch[0].toLowerCase() : null,
          status: statusMatch ? statusMatch[1] : null,
          cardText,
        });
      }
    }
    return Array.from(out.values());
  }, PROJECT_REF_RE.source);

  if (!projects.length) {
    const snippet = await s.page.evaluate(() => document.body.innerText.slice(0, 800));
    console.log(`FAIL: no projects found at ${s.page.url()}. First 800 chars: ${snippet.replace(/\n/g, ' | ')}`);
    process.exit(1);
  }

  console.log(`[trajectory] found ${projects.length} project(s)`);
  for (const p of projects) {
    console.log(`  - ${p.ref}  ${p.name.padEnd(28)}  region=${p.region ?? '?'}  status=${p.status ?? '?'}`);
  }
  console.log('---');
  // JSON line so callers can pipe to jq.
  console.log('PROJECTS_JSON ' + JSON.stringify(projects.map(({ cardText, ...rest }) => rest)));
  console.log(`PASS: listed ${projects.length} Supabase project(s)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exit(1);
} finally {
  await s.close();
}
