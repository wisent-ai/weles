// Mint a Linear personal API key.
//
// Drives Google Workspace SSO into linear.app (same path as login.mjs),
// navigates to /settings/api, clicks "Create new" / "New API key",
// enters a label (default: "oko"), and scrapes the lin_api_… token
// from the post-create reveal dialog.
//
// On success:
//   - writes the key to ~/.linear/token (chmod 600)
//   - prints the key to stdout (only if PRINT_SECRETS=1; otherwise masked)
//
// Linear personal API keys cannot be re-revealed after the create dialog
// closes — re-running this trajectory mints a fresh key.
//
// Run: node scripts/trajectories/linear/get_api_key.mjs [label]
import { readScopedLogin } from '../../_shared/scoped-secrets.mjs';
import { WSession } from '../../../dist/session/wsession.js';
import { SessionStore } from '../../../dist/session/store.js';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const LABEL = process.argv[2] || 'oko';
const LOGIN_URL = 'https://linear.app/login';
// Personal API keys are minted from the "Security & access" settings tab,
// reachable via the inline "security & access settings" link in the Member
// API keys section of the workspace /settings/api page. We navigate to
// /settings/api first, then follow that inline link to discover the
// canonical security-page URL Linear uses (varies across releases).
// Workspace-prefixed URLs skip Linear's linear:// deep-link interstitial.
const WORKSPACE_HOME = 'https://linear.app/';
const API_PATH = '/settings/api';
const SUCCESS_URL_RE = /linear\.app\/[^/]+\/(team|my|issues|inbox|settings)/;
const DISPLAY_NAME = 'Linear';
const TOKEN_PATH = `${process.env.HOME}/.linear/token`;
const PRINT_SECRETS = process.env.PRINT_SECRETS === '1';

async function resolveCreds() {
  return { ...readScopedLogin('linearDashboard'), source: 'skarbiec' };
}

const creds = await resolveCreds();
if (!creds) throw new Error('scoped Linear credentials are unavailable');
console.log(`[linear-key] credentials from ${creds.source}: ${creds.email}`);
console.log(`[linear-key] label="${LABEL}"`);

// Label matches the trajectory filename (get_api_key) so recordings land in
// recordings/get_api_key/ and the artifact-inspection hook's label-pinned
// scanner finds them. OS pinned to macos so the persona fingerprint is stable
// run-to-run — Google's anti-bot challenges flipping fingerprints. Cookies
// from prior successful runs are auto-injected via SessionStore by label.
const s = await WSession.start({ label: 'get_api_key', browser: 'chromium', os: 'macos' });
const store = new SessionStore();
let exitCode = 0;
try {
  // Go to the workspace root first. With cookies, Linear redirects to
  // /<workspace_slug>/inbox or /<workspace_slug>/team/<TEAM>/active; without
  // cookies it shows /login and the Continue-with-Google button.
  await s.goto(WORKSPACE_HOME);
  await humanIdlePause('deliberate');
  console.log(`[linear-key] post-goto url=${s.page.url()}`);

  // Detect "needs login" by the presence of the Continue with Google button,
  // not by URL pattern — a missing button means we're already logged in.
  const googleBtn = s.page.getByRole('button', { name: /continue with google/i })
    .or(s.page.getByRole('link', { name: /continue with google/i }));
  const needsLogin = await googleBtn.first().isVisible().catch(() => false);
  console.log(`[linear-key] needsLogin=${needsLogin}`);
  if (needsLogin) {
    console.log('[linear-key] clicking Continue with Google');
    await humanClickLocator(s.page, googleBtn.first(), { timeoutMs: 15000 });
    await humanIdlePause('long');
    console.log(`[linear-key] post-google-click url=${s.page.url()}`);

    // Google may show the "Choose an account" chooser if a partial session
    // cookie remains from a prior SSO. Click the matching account tile.
    const accountTile = s.page.locator(`div[data-identifier="${creds.email}"]`)
      .or(s.page.locator(`[data-email="${creds.email}"]`))
      .or(s.page.getByText(creds.email, { exact: true }));
    if (await accountTile.first().isVisible().catch(() => false)) {
      console.log(`[linear-key] account chooser: clicking ${creds.email}`);
      await humanClickLocator(s.page, accountTile.first(), { timeoutMs: 10000 });
      await humanIdlePause('long');
    }

    const emailInput = s.page.locator('input[type="email"]').first();
    if (await emailInput.isVisible().catch(() => false)) {
      console.log('[linear-key] filling Google email');
      await humanFill(s.page, emailInput, creds.email);
      await s.page.keyboard.press('Enter');
      await humanIdlePause('long');
    }
    console.log(`[linear-key] post-email url=${s.page.url()}`);

    // Google may interpose a passkey / device-verification challenge before
    // the password field. Walk it down: click "Try another way", then click
    // "Use your password". Single-shot — if Google's challenge is sticky, the
    // password input still won't be visible after these clicks and the run
    // surfaces a clear FAIL with the current URL.
    const tryOther = s.page.getByRole('button', { name: /try another way|another way to sign in/i })
      .or(s.page.getByRole('link', { name: /try another way|another way to sign in/i }));
    if (await tryOther.first().isVisible().catch(() => false)) {
      console.log('[linear-key] clicking "Try another way"');
      await humanClickLocator(s.page, tryOther.first(), { timeoutMs: 10000 });
      await humanIdlePause('long');
    }
    const usePwd = s.page.getByRole('button', { name: /(use|enter) your password/i })
      .or(s.page.getByRole('link', { name: /(use|enter) your password/i }))
      .or(s.page.getByText(/(use|enter) your password/i));
    if (await usePwd.first().isVisible().catch(() => false)) {
      console.log('[linear-key] clicking "Use your password"');
      await humanClickLocator(s.page, usePwd.first(), { timeoutMs: 10000 });
      await humanIdlePause('long');
    }

    const pwd = s.page.locator('input[type="password"]');
    if (await pwd.count() > 0 && await pwd.first().isVisible().catch(() => false)) {
      console.log('[linear-key] filling Google password');
      await humanFill(s.page, pwd.first(), creds.password);
      await s.page.keyboard.press('Enter');
      await humanIdlePause('long');
    } else {
      console.log(`[linear-key] WARN: no password input visible, url=${s.page.url()}`);
    }
    const continueBtn = s.page.getByRole('button', { name: /^\s*continue\s*$/i });
    if (await continueBtn.count() > 0) {
      await humanClickLocator(s.page, continueBtn.first(), { timeoutMs: 10000 });
      await humanIdlePause('long');
    }
    let landed = false;
    for (let i = 0; i < 30; i++) {
      await humanIdlePause('short');
      if (SUCCESS_URL_RE.test(s.page.url())) { landed = true; break; }
    }
    if (!landed) { throw new Error(`SSO did not complete, url=${s.page.url()}`); }
    console.log(`[linear-key] SSO complete, url=${s.page.url()}`);

    // Capture cookies now that login succeeded — future runs reuse this via
    // SessionStore.injectPlaywright in WSession.start, skipping Google SSO
    // entirely (its v3/signin/challenge anti-bot is the main flakiness source).
    try {
      await store.capturePlaywright(s.ctx, 'get_api_key');
      console.log('[linear-key] persisted session cookies to ~/.weles/sessions.json[get_api_key]');
    } catch (e) {
      console.log(`[linear-key] WARN: could not persist cookies: ${e.message?.slice(0, 100)}`);
    }

  }

  // Extract the workspace slug from the current URL (post-login or post-SSO)
  // and navigate to the workspace-prefixed settings/api so Linear doesn't
  // route through its desktop-app deep-link interstitial.
  const slugMatch = s.page.url().match(/linear\.app\/([^/]+)\//);
  if (!slugMatch) {
    throw new Error(`could not extract workspace slug from url=${s.page.url()}`);
  }
  const slug = slugMatch[1];
  const apiUrl = `https://linear.app/${slug}${API_PATH}`;
  console.log(`[linear-key] navigating to ${apiUrl}`);
  await s.page.goto(apiUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  console.log(`[linear-key] post-nav url=${s.page.url()}`);

  // The Member API keys section has an inline link "security & access
  // settings" that points to the canonical personal-key page. Click it
  // and let Linear navigate, then re-read the URL.
  const inlineLink = s.page.getByRole('link', { name: /security\s*&\s*access\s*settings/i });
  if (await inlineLink.first().isVisible().catch(() => false)) {
    console.log('[linear-key] clicking inline "security & access settings" link');
    await humanClickLocator(s.page, inlineLink.first(), { timeoutMs: 10000 });
    await humanIdlePause('long');
    console.log(`[linear-key] after-link url=${s.page.url()}`);
  } else {
    console.log('[linear-key] inline link not visible — trying sidebar tab');
    const sidebarLink = s.page.getByRole('link', { name: /^security\s*&\s*access$/i })
      .or(s.page.getByRole('button', { name: /^security\s*&\s*access$/i }));
    if (await sidebarLink.first().isVisible().catch(() => false)) {
      await humanClickLocator(s.page, sidebarLink.first(), { timeoutMs: 10000 });
      await humanIdlePause('long');
      console.log(`[linear-key] after-sidebar url=${s.page.url()}`);
    }
  }

  // Now on the security-and-access page: probe for the personal-API-keys
  // section and find the create button beside it.
  const personalProbe = await s.page.evaluate(() => {
    const heads = Array.from(document.querySelectorAll('h1, h2, h3, h4, [role="heading"]'));
    const h = heads.find(el => /personal api key|api key/i.test((el.innerText || '').trim()));
    if (!h) return { found: false, reason: 'no personal API keys heading on security page' };
    h.scrollIntoView({ block: 'center' });
    const section = h.closest('section, div, article') || h.parentElement;
    const buttons = Array.from(section.querySelectorAll('button, a[role="button"], a'))
      .filter(b => b.offsetParent !== null)
      .map(b => ({ tag: b.tagName.toLowerCase(), text: (b.innerText || b.textContent || '').trim().slice(0, 60), aria: b.getAttribute('aria-label') }));
    return { found: true, headingText: (h.innerText || '').trim().slice(0, 80), buttons };
  });
  console.log(`[linear-key] personal-key probe: ${JSON.stringify(personalProbe).slice(0, 600)}`);
  await humanIdlePause('short');

  // Click "New API key" / "Create new" / "Create key" inside the personal
  // keys section.
  const createBtn = s.page.locator(
    'button:has-text("New API key"), button:has-text("Create key"), button:has-text("Create new"), button:has-text("Personal API key"), button[aria-label*="create" i][aria-label*="key" i], button[aria-label*="new" i][aria-label*="key" i]'
  ).filter({ visible: true }).first();
  if (!(await createBtn.isVisible().catch(() => false))) {
    // Dump page state for diagnosis.
    const dump = await s.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a[role="button"]'))
        .filter(b => b.offsetParent !== null)
        .map(b => (b.innerText || b.textContent || '').trim().slice(0, 80))
        .filter(t => t.length);
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map(h => (h.innerText || '').trim().slice(0, 120))
        .filter(t => t.length);
      return { url: location.href, title: document.title, headings, buttons: buttons.slice(0, 40) };
    });
    console.log(`[diagnostic] url=${dump.url} title="${dump.title}"`);
    console.log(`[diagnostic] headings: ${dump.headings.join(' | ')}`);
    console.log(`[diagnostic] visible buttons (first 40): ${dump.buttons.join(' | ')}`);
    throw new Error(`"Create new" button not visible on /settings/api`);
  }
  await humanClickLocator(s.page, createBtn);
  await humanIdlePause('short');

  // Fill the label in the create dialog.
  const labelInput = s.page.locator(
    'input[placeholder*="Label" i], input[placeholder*="Name" i], input[placeholder*="key name" i]'
  ).filter({ visible: true }).first();
  if (await labelInput.isVisible().catch(() => false)) {
    await humanFill(s.page, labelInput, LABEL);
    await humanIdlePause('short');
  } else {
    console.log('[linear-key] WARN: label input not visible — proceeding anyway');
  }

  // Confirm.
  const confirmBtn = s.page.locator(
    'button:has-text("Create"):not(:has-text("Create new")), button:has-text("Generate"), button[type="submit"]'
  ).filter({ visible: true }).last();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, confirmBtn);
  }
  await humanIdlePause('long');

  // Scrape the lin_api_… key from the reveal dialog.
  const scraped = await s.page.evaluate(() => {
    const text = document.body.innerText;
    const inputs = Array.from(document.querySelectorAll('input, code, textarea'));
    const re = /lin_api_[A-Za-z0-9_-]{20,}/;
    for (const el of inputs) {
      const v = (el.value ?? el.textContent ?? '').trim();
      const m = v.match(re);
      if (m) return { key: m[0], source: el.tagName.toLowerCase() };
    }
    const bodyMatch = text.match(re);
    if (bodyMatch) return { key: bodyMatch[0], source: 'body-text' };
    return { key: null, snippet: text.slice(0, 400) };
  });

  if (!scraped.key) {
    throw new Error(`no lin_api_ token found after create. Snippet: ${(scraped.snippet || '').replace(/\n/g, ' | ').slice(0, 400)}`);
  }

  // Persist to ~/.linear/token (chmod 600).
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, scraped.key + '\n', 'utf8');
  chmodSync(TOKEN_PATH, 0o600);

  console.log('---');
  console.log(`label             : ${LABEL}`);
  console.log(`linear_api_key    : ${PRINT_SECRETS ? scraped.key : maskKey(scraped.key)}`);
  console.log(`persisted_to      : ${TOKEN_PATH}`);
  console.log(`scraped_from      : ${scraped.source}`);
  console.log('---');
  if (!PRINT_SECRETS) console.log('(re-run with PRINT_SECRETS=1 to dump the full key to stdout)');
  console.log(`PASS: minted linear personal api key, persisted to ${TOKEN_PATH}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
  exitCode = 1;
} finally {
  await s.close();
}
process.exit(exitCode);

function maskKey(k) {
  if (!k) return '(none)';
  return `${k.slice(0, 12)}…${k.slice(-4)}`;
}
