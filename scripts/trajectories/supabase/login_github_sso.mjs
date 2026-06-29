// Supabase dashboard login + API-key extraction via GitHub SSO.
//
// Usage:
//   GITHUB_USER=wisent-maker GITHUB_PASS='Warszawa432!' \
//     node scripts/trajectories/supabase/login_github_sso.mjs <project_ref>
//
// Or with PRINT_SECRETS=1 to dump full keys at the end.
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const projectRef = process.argv[2] ?? 'yqizdfkfnmhddfemdxtq';
const GITHUB_USER = process.env.GITHUB_USER ?? '';
const GITHUB_PASS = process.env.GITHUB_PASS ?? '';
const PRINT_SECRETS = process.env.PRINT_SECRETS === '1';

if (!GITHUB_USER || !GITHUB_PASS) {
  console.log('FAIL: set GITHUB_USER and GITHUB_PASS env vars');
  process.exit(1);
}
if (!/^[a-z]{20}$/.test(projectRef)) {
  console.log('FAIL: project_ref must be 20 lowercase chars');
  process.exit(1);
}

const s = await WSession.start({ label: `supabase_github_sso_${projectRef}`, browser: 'chromium' });
try {
  // 1. Log in to GitHub.
  console.log('[trajectory] logging in to GitHub');
  await s.goto('https://github.com/login');
  await humanIdlePause('deliberate');

  const userIn = s.page.locator('input[name="login"], input#login_field, input[type="text"]').filter({ visible: true }).first();
  const pwIn = s.page.locator('input[name="password"], input#password, input[type="password"]').filter({ visible: true }).first();
  if (!(await userIn.isVisible().catch(() => false)) || !(await pwIn.isVisible().catch(() => false))) {
    console.log('FAIL: GitHub login inputs not visible');
    process.exit(1);
  }
  await humanFill(s.page, userIn, GITHUB_USER);
  await humanIdlePause('short');
  await humanFill(s.page, pwIn, GITHUB_PASS);
  await humanIdlePause('short');

  const submit = s.page.locator('input[type="submit"][value*="Sign in"], button[type="submit"]').filter({ visible: true }).first();
  if (await submit.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, submit).catch(() => {});
  } else {
    await s.page.keyboard.press('Enter');
  }

  let githubOk = false;
  for (let i = 0; i < 20; i++) {
    await humanIdlePause('short');
    const u = s.page.url();
    if (!u.includes('/login') && !u.includes('/session') && u.includes('github.com')) { githubOk = true; break; }
  }
  if (!githubOk) {
    const u = s.page.url();
    const text = await s.page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
    console.log(`FAIL: GitHub login did not redirect (url=${u} text=${text.replace(/\n/g, ' ').slice(0, 200)})`);
    process.exit(1);
  }
  console.log(`[trajectory] GitHub logged in: ${s.page.url()}`);

  // 2. Supabase sign-in via GitHub SSO.
  console.log('[trajectory] opening Supabase sign-in');
  await s.goto('https://supabase.com/dashboard/sign-in');
  await humanIdlePause('long');

  const ghBtn = s.page.locator('button:has-text("Continue with GitHub"), button:has-text("Sign in with GitHub"), a:has-text("Continue with GitHub"), a:has-text("Sign in with GitHub")').filter({ visible: true }).first();
  if (!(await ghBtn.isVisible().catch(() => false))) {
    // May already be logged in if GitHub session was recognized.
    const u = s.page.url();
    if (u.includes('/dashboard/projects') || u.includes('/dashboard/project/')) {
      console.log(`[trajectory] already on Supabase dashboard: ${u}`);
    } else {
      console.log('FAIL: GitHub SSO button not visible on Supabase sign-in');
      process.exit(1);
    }
  } else {
    // OAuth may open in a popup or redirect in the same tab. Listen for popups.
    let oauthPage = null;
    const popupPromise = s.page.context().waitForEvent('page', { timeout: 5_000 }).catch(() => null);
    await humanClickLocator(s.page, ghBtn).catch(() => {});
    await humanIdlePause('short');
    oauthPage = await popupPromise;
    if (oauthPage) console.log(`[trajectory] OAuth popup detected`);

    const oauth = oauthPage ?? s.page;

    // GitHub OAuth flow: may land on /login (re-auth) or /login/oauth/authorize (consent).
    let supaOk = false;
    for (let i = 0; i < 40; i++) {
      await humanIdlePause('short');
      const u = oauth.url();
      if (u.includes('/dashboard/projects') || u.includes('/dashboard/project/') || u.includes('/dashboard/org')) { supaOk = true; break; }

      if (u.includes('github.com/login') && !u.includes('/oauth/')) {
        // Re-authentication required; fill credentials again.
        const userIn2 = oauth.locator('input[name="login"], input#login_field, input[type="text"]').filter({ visible: true }).first();
        const pwIn2 = oauth.locator('input[name="password"], input#password, input[type="password"]').filter({ visible: true }).first();
        if (await userIn2.isVisible().catch(() => false) && await pwIn2.isVisible().catch(() => false)) {
          await humanFill(oauth, userIn2, GITHUB_USER);
          await humanIdlePause('short');
          await humanFill(oauth, pwIn2, GITHUB_PASS);
          await humanIdlePause('short');
          const submit2 = oauth.locator('input[type="submit"][value*="Sign in"], button[type="submit"]').filter({ visible: true }).first();
          if (await submit2.isVisible().catch(() => false)) await humanClickLocator(oauth, submit2).catch(() => {});
          else await oauth.keyboard.press('Enter');
          await humanIdlePause('deliberate');
        }
      } else if (u.includes('github.com/login/oauth/authorize')) {
        const authzBtn = oauth.locator('button[type="submit"][name="authorize"], button:has-text("Authorize"), input[type="submit"][value*="Authorize"]').filter({ visible: true }).first();
        if (await authzBtn.isVisible().catch(() => false)) {
          await humanClickLocator(oauth, authzBtn).catch(() => {});
          await humanIdlePause('deliberate');
        }
      }
    }

    if (oauthPage && !oauthPage.isClosed()) {
      // Wait for popup to close and main page to reach dashboard.
      for (let i = 0; i < 20 && !oauthPage.isClosed(); i++) await humanIdlePause('short');
      for (let i = 0; i < 20; i++) {
        await humanIdlePause('short');
        const u = s.page.url();
        if (u.includes('/dashboard/projects') || u.includes('/dashboard/project/') || u.includes('/dashboard/org')) { supaOk = true; break; }
      }
    }

    if (!supaOk) {
      const u = s.page.url();
      const popupUrl = oauthPage && !oauthPage.isClosed() ? oauthPage.url() : '(closed)';
      const text = await s.page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
      console.log(`FAIL: Supabase SSO did not land on dashboard (main=${u} popup=${popupUrl} text=${text.replace(/\n/g, ' ').slice(0, 200)})`);
      process.exit(1);
    }
  }
  console.log(`[trajectory] Supabase logged in: ${s.page.url()}`);

  // 3. Open project list and select the target project.
  console.log('[trajectory] navigating to project list');
  await s.page.goto('https://supabase.com/dashboard/projects', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');

  // Click the project link by ref or name.
  const projectLink = s.page.locator(`a[href*="/dashboard/project/${projectRef}"], a:has-text("Content platform")`).filter({ visible: true }).first();
  if (await projectLink.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, projectLink).catch(() => {});
    await humanIdlePause('long');
  } else {
    console.log(`[trajectory] project link not visible, trying direct URL`);
  }

  // 4. Navigate to API settings and reveal keys.
  // Try the "Connect" button on the project homepage — it opens a modal with
  // project URL + anon/service_role keys in newer Supabase UI.
  const projectHome = `https://supabase.com/dashboard/project/${projectRef}`;
  console.log(`[trajectory] navigating to ${projectHome}`);
  await s.page.goto(projectHome, { waitUntil: 'networkidle' });
  await humanIdlePause('long');

  const connectBtn = s.page.locator('button:has-text("Connect"), a:has-text("Connect")').filter({ visible: true }).first();
  if (await connectBtn.isVisible().catch(() => false)) {
    console.log('[trajectory] clicking Connect button');
    await humanClickLocator(s.page, connectBtn).catch(() => {});
    await humanIdlePause('long');
  }

  // JWT keys are usually under the "Direct" tab (connection string / raw keys).
  const directTab = s.page.locator('button:has-text("Direct"), [role="tab"]:has-text("Direct")').filter({ visible: true }).first();
  if (await directTab.isVisible().catch(() => false)) {
    console.log('[trajectory] clicking Direct tab');
    await humanClickLocator(s.page, directTab).catch(() => {});
    await humanIdlePause('long');
  }

  // Wait for the keys section to render (it fetches after navigation).
  for (let i = 0; i < 20; i++) {
    const hasKeys = await s.page.evaluate(() => {
      const text = document.body.innerText;
      return /Project URL|anon|service_role|JWT|API keys|Data API|API URL|project_url/.test(text);
    }).catch(() => false);
    if (hasKeys) break;
    await humanIdlePause('short');
  }

  // Scroll the API keys section into view and reveal hidden inputs.
  await s.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => {});
  await humanIdlePause('short');

  for (const sel of [
    'button:has-text("Reveal")',
    'button[aria-label*="reveal" i]',
    'button[aria-label*="show" i]',
    'button[title*="Reveal" i]',
    'button[title*="Show" i]',
  ]) {
    const btns = await s.page.locator(sel).all().catch(() => []);
    for (const b of btns) {
      if (await b.isVisible().catch(() => false)) {
        await humanClickLocator(s.page, b).catch(() => {});
        await humanIdlePause('short');
      }
    }
  }
  await humanIdlePause('short');

  // Diagnostic screenshot + URL before scraping.
  const preScrapeUrl = s.page.url();
  console.log(`[trajectory] pre-scrape url=${preScrapeUrl}`);
  try {
    const dir = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/recordings/local/supabase_github_sso_yqizdfkfnmhddfemdxtq';
    await s.page.screenshot({ path: `${dir}/api_settings.png`, fullPage: true });
    console.log(`[trajectory] screenshot saved to ${dir}/api_settings.png`);
  } catch {}

  // 4. Scrape keys.
  const scraped = await s.page.evaluate((ref) => {
    const text = document.body.innerText;
    const projectUrlMatch = text.match(new RegExp(`https://${ref}\\.supabase\\.(?:co|in|net)`));
    const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/g;
    const inputs = Array.from(document.querySelectorAll('input')).map(i => i.value || '').filter(v => jwtRe.test(v));
    jwtRe.lastIndex = 0;
    const bodyJwts = Array.from(text.matchAll(jwtRe)).map(m => m[0]);
    const seen = new Set();
    const all = [...inputs, ...bodyJwts].filter(j => { if (seen.has(j)) return false; seen.add(j); return true; });
    const decoded = all.map(jwt => {
      try {
        const payloadB64 = jwt.split('.')[1];
        const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
        const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
        const obj = JSON.parse(json);
        return { jwt, role: obj.role ?? null, ref: obj.ref ?? null };
      } catch { return { jwt, role: null, ref: null }; }
    });
    return { projectUrl: projectUrlMatch?.[0] ?? null, jwts: decoded, textSnippet: text.slice(0, 600) };
  }, projectRef);

  const anon = scraped.jwts.find(j => j.role === 'anon' && j.ref === projectRef);
  const serviceRole = scraped.jwts.find(j => j.role === 'service_role' && j.ref === projectRef);

  if (!scraped.projectUrl || !anon || !serviceRole) {
    console.log(`FAIL: could not scrape keys. url=${scraped.projectUrl} jwts=${scraped.jwts.length} snippet=${scraped.textSnippet.replace(/\n/g, ' ').slice(0, 300)}`);
    process.exit(1);
  }

  console.log('---');
  console.log(`project_ref       : ${projectRef}`);
  console.log(`project_url       : ${scraped.projectUrl}`);
  console.log(`anon_key          : ${PRINT_SECRETS ? anon.jwt : maskJwt(anon.jwt)}`);
  console.log(`service_role_key  : ${PRINT_SECRETS ? serviceRole.jwt : maskJwt(serviceRole.jwt)}`);
  console.log('---');
  if (!PRINT_SECRETS) console.log('(re-run with PRINT_SECRETS=1 to dump full keys)');

  console.log('');
  console.log('=== ENV VARS ===');
  console.log(`NEXT_PUBLIC_SUPABASE_URL=${scraped.projectUrl}`);
  console.log(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${PRINT_SECRETS ? anon.jwt : maskJwt(anon.jwt)}`);
  console.log(`SUPABASE_SERVICE_ROLE_KEY=${PRINT_SECRETS ? serviceRole.jwt : maskJwt(serviceRole.jwt)}`);
  console.log('================');
  console.log(`PASS: scraped api keys for project ${projectRef}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exit(1);
} finally {
  await s.close();
}

function maskJwt(jwt) {
  if (!jwt) return '(none)';
  const parts = jwt.split('.');
  if (parts.length !== 3) return jwt.slice(0, 12) + '...';
  return `${parts[0].slice(0, 12)}...${parts[2].slice(-6)}`;
}
