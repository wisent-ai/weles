// Create a Slack app from the local manifest.yaml, install it to the Wisent
// workspace, and return the resulting xoxb bot token.
//
// API-only path. The "Create app from manifest" dialog has too many
// React/click failure modes across personas; instead this:
//   1. Extracts xoxc from window.boot_data in the workspace web client.
//   2. POSTs /api/apps.manifest.create with xoxc as Bearer (Slack accepts
//      xoxc for admin-style write endpoints when the user has perms).
//   3. Navigates to /apps/<id>/install-on-team, scrapes the OAuth URL.
//   4. POSTs the OAuth consent form via page.context().request (the only
//      reliable way past Slack's anti-bot synthetic-click rejection on
//      the Allow button — x-slack-shared-secret-outcome: no-match).
//   5. Scrapes xoxb from input.value on /apps/<id>/oauth.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Manifest as JS object → JSON for the apps.manifest.create API. The web
// UI accepts YAML, but the xoxc-authed API path requires JSON-stringified
// manifest (verified live: YAML with xoxc returns invalid_manifest with
// no detail; JSON works).
const SWIATOWID_MANIFEST = {
  display_information: {
    name: 'Oko',
    description: 'Wisent macOS dock for Claude Code sessions - posts status updates.',
    background_color: '#1f1f1f',
  },
  features: {
    bot_user: { display_name: 'Oko', always_online: true },
  },
  oauth_config: {
    scopes: {
      bot: [
        'chat:write',
        'chat:write.public',
        'channels:read',
        'channels:history',
        'users:read',
        'users:read.email',
        'im:write',
        'im:history',
        'mpim:write',
        'mpim:history',
      ],
    },
  },
  settings: {
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  },
};

/** Returns the xoxb- bot token (empty string on any failure). */
export async function createBotApp({ page, weles, shot }) {
  const { humanIdlePause } = await import(`${weles}/dist/human/mouse.js`);

  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/api\/apps\.manifest|api\/auth\.test/.test(u)) return;
    try {
      const body = await resp.text();
      console.log(`[bot][api] ${resp.status()} ${u.split('?')[0]} -> ${body.slice(0, 600)}`);
    } catch (e) { /* body unavailable */ }
  });

  // Extract xoxc workspace token from the Slack web client. Cookies seat
  // automatically via the same browser context (we're already SSO'd).
  await page.goto('https://wisent-workspace.slack.com/messages', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const xoxc = await page.evaluate(() => {
    if (window.boot_data && window.boot_data.api_token) return window.boot_data.api_token;
    for (let i = 0; i < localStorage.length; i++) {
      const v = localStorage.getItem(localStorage.key(i)) || '';
      const m = v.match(/xoxc-[\d]+-[\d]+-[\d]+-[a-f0-9]+/);
      if (m) return m[0];
    }
    return '';
  });
  if (!xoxc) throw new Error('[bot] no xoxc token in window.boot_data or localStorage');
  console.log(`[bot] xoxc=${xoxc.slice(0, 24)}… len=${xoxc.length}`);

  const manifest = JSON.stringify(SWIATOWID_MANIFEST);
  console.log(`[bot] POST /api/apps.manifest.create (manifest ${manifest.length} chars JSON, with xoxc)`);
  // First validate to surface the exact field-level error before attempting create.
  const validateResp = await page.context().request.post('https://slack.com/api/apps.manifest.validate', {
    headers: { 'Authorization': `Bearer ${xoxc}` },
    multipart: { manifest, token: xoxc },
  });
  const validate = await validateResp.json();
  console.log(`[bot][validate] ${JSON.stringify(validate).slice(0, 1500)}`);
  if (!validate.ok) throw new Error(`[bot] apps.manifest.validate failed: ${JSON.stringify(validate).slice(0, 500)}`);

  const createResp = await page.context().request.post('https://slack.com/api/apps.manifest.create', {
    headers: { 'Authorization': `Bearer ${xoxc}` },
    multipart: { manifest, token: xoxc },
  });
  const create = await createResp.json();
  console.log(`[bot][create] ${JSON.stringify(create).slice(0, 1500)}`);
  if (!create.ok) {
    throw new Error(`[bot] apps.manifest.create failed: ${JSON.stringify(create).slice(0, 500)}`);
  }
  const appId = create.app_id;
  if (!appId) throw new Error(`[bot] apps.manifest.create returned no app_id: ${JSON.stringify(create).slice(0, 200)}`);
  console.log(`[bot] ✓ app created via API: id=${appId}`);
  await shot('08-app-created');

  // Install: load install-on-team to render the per-app OAuth authorize URL.
  await page.goto(`https://api.slack.com/apps/${appId}/install-on-team`, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const oauthHref = await page.evaluate(() =>
    (Array.from(document.querySelectorAll('a')).find(
      a => /install to/i.test(a.textContent || '') && /oauth\/v2\/authorize/.test(a.href)
    ) || {}).href || ''
  );
  if (!oauthHref) throw new Error('[bot] no Install→OAuth href found on install-on-team page');
  await page.goto(oauthHref, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await shot('10-oauth-consent');

  const formAction = await page.evaluate(() => document.querySelector('#oauth_install_form')?.action || '');
  const formBody = await page.evaluate(() => {
    const f = document.querySelector('#oauth_install_form');
    if (!f) return '';
    const p = new URLSearchParams();
    f.querySelectorAll('input[type=hidden]').forEach(i => p.append(i.name, i.value));
    return p.toString();
  });
  if (!formAction || !formBody) throw new Error('[bot] OAuth consent form not found');
  const allowResp = await page.context().request.post(formAction, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: formBody, maxRedirects: 5,
  });
  if (allowResp.status() !== 200 || !allowResp.url().includes('success=1')) {
    throw new Error(`[bot] OAuth POST rejected: ${allowResp.status()} ${allowResp.url()}`);
  }
  console.log('[bot] ✓ OAuth Allow accepted');

  await page.goto(`https://api.slack.com/apps/${appId}/oauth`, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  await shot('11-oauth-page');
  const xoxb = await page.evaluate(() => {
    const fromInputs = Array.from(document.querySelectorAll('input,textarea'))
      .map(i => i.value || '').find(v => /^xoxb-/.test(v));
    if (fromInputs) return fromInputs;
    const m = (document.body.innerText || '').match(/xoxb-\d+-\d+-[A-Za-z0-9]+/);
    return m ? m[0] : '';
  });
  return xoxb || '';
}
