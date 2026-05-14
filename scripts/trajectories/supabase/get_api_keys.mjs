// Supabase API-keys extractor.
//
// Usage:  node scripts/trajectories/supabase/get_api_keys.mjs <project_ref>
//
// Logs in with email+password, navigates to
//   /dashboard/project/<ref>/settings/api
// and scrapes:
//   - Project URL  (https://<ref>.supabase.co)
//   - anon (public) key
//   - service_role (secret) key — clicks "Reveal" first
//
// Prints them as ENV-variable assignments at the end so the operator can
// paste them into .env. Never logs the service_role key without the explicit
// PRINT_SECRETS=1 env var because it's a long-lived secret.

import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const projectRef = process.argv[2];
if (!projectRef || !/^[a-z]{20}$/.test(projectRef)) {
  console.log('FAIL: usage: get_api_keys.mjs <project_ref>  (20-char lowercase, e.g. yqizdfkfnmhddfemdxtq)');
  process.exit(1);
}

const SIGNIN_URL = 'https://supabase.com/dashboard/sign-in';
const API_URL = `https://supabase.com/dashboard/project/${projectRef}/settings/api`;
const DISPLAY_NAME = 'Supabase';
const PRINT_SECRETS = process.env.PRINT_SECRETS === '1';

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) { console.log(`FAIL: no '${DISPLAY_NAME}' row in service_credentials`); process.exit(1); }
console.log(`[trajectory] Using service login: ${login.email}`);
console.log(`[trajectory] Target project ref: ${projectRef}`);

const s = await WSession.start({ label: `supabase_get_api_keys_${projectRef}`, browser: 'chromium' });
try {
  await s.goto(SIGNIN_URL);
  await humanIdlePause('deliberate');

  if (/\/dashboard\/sign-in/.test(s.page.url())) {
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

  console.log(`[trajectory] navigating to ${API_URL}`);
  await s.page.goto(API_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');

  // If the project ref is wrong or we lack access, Supabase shows a 404
  // page. Detect early and bail with a clear error.
  const url = s.page.url();
  if (/\/404($|\?|\/)/.test(url) || /not[-_ ]found/i.test(url)) {
    console.log(`FAIL: project ${projectRef} not accessible (url=${url})`);
    process.exit(1);
  }

  // Reveal service_role key. Supabase renders the key behind a "Reveal" or
  // eye-icon toggle. Click every plausible reveal button — clicking an already-
  // revealed one is a no-op.
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
        try { await humanClickLocator(s.page, b); } catch { /* button may have re-rendered */ }
        await humanIdlePause('short');
      }
    }
  }
  await humanIdlePause('short');

  const scraped = await s.page.evaluate((ref) => {
    const text = document.body.innerText;
    // Project URL: https://<ref>.supabase.co (or .in for some regions).
    const projectUrlMatch = text.match(new RegExp(`https://${ref}\\.supabase\\.(?:co|in|net)`));
    // JWTs are dot-separated base64url segments, header.payload.signature.
    // The header for Supabase keys decodes to {"alg":"HS256","typ":"JWT"} which
    // base64url-encodes to "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9".
    // We grab any 3-segment JWT-shape token in inputs OR body text.
    const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

    // Inputs first (Supabase uses readonly <input> for keys).
    const inputs = Array.from(document.querySelectorAll('input'));
    const inputJwts = inputs.map(i => i.value || '').filter(v => jwtRe.test(v));
    jwtRe.lastIndex = 0;
    const bodyJwts = Array.from(text.matchAll(jwtRe)).map(m => m[0]);

    // De-dup + classify by decoding payload role claim.
    const seen = new Set();
    const all = [...inputJwts, ...bodyJwts].filter(j => { if (seen.has(j)) return false; seen.add(j); return true; });
    const decoded = all.map(jwt => {
      try {
        const payloadB64 = jwt.split('.')[1];
        const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
        const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
        const obj = JSON.parse(json);
        return { jwt, role: obj.role ?? null, ref: obj.ref ?? null, iss: obj.iss ?? null };
      } catch { return { jwt, role: null, ref: null, iss: null }; }
    });
    return {
      projectUrl: projectUrlMatch ? projectUrlMatch[0] : null,
      jwts: decoded,
      textSnippet: text.slice(0, 800),
    };
  }, projectRef);

  const anon = scraped.jwts.find(j => j.role === 'anon' && j.ref === projectRef);
  const serviceRole = scraped.jwts.find(j => j.role === 'service_role' && j.ref === projectRef);
  // Some legacy keys have role null; fall back to first/second in that case.
  const fallbackAnon = anon || scraped.jwts[0];
  const fallbackServiceRole = serviceRole || scraped.jwts.find(j => j !== fallbackAnon);

  if (!scraped.projectUrl) {
    console.log(`FAIL: project URL not found on page. Snippet: ${scraped.textSnippet.replace(/\n/g, ' | ').slice(0, 400)}`);
    process.exit(1);
  }
  if (!fallbackAnon || !fallbackServiceRole) {
    console.log(`FAIL: could not find both anon + service_role JWTs (found ${scraped.jwts.length} JWT-shaped tokens). Snippet: ${scraped.textSnippet.replace(/\n/g, ' | ').slice(0, 400)}`);
    process.exit(1);
  }

  console.log('---');
  console.log(`project_ref       : ${projectRef}`);
  console.log(`project_url       : ${scraped.projectUrl}`);
  console.log(`anon_key          : ${PRINT_SECRETS ? fallbackAnon.jwt : maskJwt(fallbackAnon.jwt)}`);
  console.log(`service_role_key  : ${PRINT_SECRETS ? fallbackServiceRole.jwt : maskJwt(fallbackServiceRole.jwt)}`);
  console.log('---');
  if (!PRINT_SECRETS) console.log('(re-run with PRINT_SECRETS=1 to dump full keys)');

  console.log('');
  console.log('=== ENV VARS ===');
  console.log(`NEXT_PUBLIC_SUPABASE_URL=${scraped.projectUrl}`);
  console.log(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${PRINT_SECRETS ? fallbackAnon.jwt : maskJwt(fallbackAnon.jwt)}`);
  console.log(`SUPABASE_SERVICE_ROLE_KEY=${PRINT_SECRETS ? fallbackServiceRole.jwt : maskJwt(fallbackServiceRole.jwt)}`);
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
