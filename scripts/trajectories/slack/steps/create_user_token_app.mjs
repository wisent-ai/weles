// Create or install a Slack app that exposes a User OAuth Token and return xoxp.
//
// Uses the same xoxc-authed manifest/OAuth install path as create_bot_app.mjs:
//   1. Extract xoxc from the already logged-in workspace web client.
//   2. Create a Slack app manifest with user scopes.
//   3. Install the app by POSTing the rendered OAuth consent form.
//   4. Scrape the User OAuth Token from /apps/<id>/oauth.
//
// Do not log the token. Callers decide where to persist or return it.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_USER_SCOPES = [
  'chat:write',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  'users:read.email',
];

function parseScopes(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function firstXoxc(value) {
  const m = String(value || '').match(/xoxc-[A-Za-z0-9-]+/);
  return m ? m[0] : '';
}

function firstXoxcFromObject(value) {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = firstXoxcFromObject(item);
      if (token) return token;
    }
    return '';
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      const token = /xoxc|slack.*web.*token|web.*slack.*token/i.test(key) ? firstXoxc(item) : '';
      if (token) return token;
    } else {
      const token = firstXoxcFromObject(item);
      if (token) return token;
    }
  }
  return '';
}

function readSlackWebTokenFromFile(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return firstXoxcFromObject(parsed) || firstXoxc(raw);
  } catch {
    return '';
  }
}

function readConfiguredXoxc() {
  const envToken = firstXoxc(process.env.SLACK_WEB_USER_TOKEN)
    || firstXoxc(process.env.SLACK_XOXC)
    || firstXoxc(process.env.SLACK_XOXC_TOKEN);
  if (envToken) return envToken;

  const paths = [
    process.env.SLACK_WEB_TOKEN_FILE,
    process.env.SLACK_TOKENS_FILE,
    join(homedir(), '.oko', 'slack_tokens.json'),
  ].filter(Boolean);
  for (const path of paths) {
    const token = readSlackWebTokenFromFile(path);
    if (token) return token;
  }
  return '';
}

function userTokenManifest(scopes) {
  return {
    display_information: {
      name: process.env.SLACK_USER_TOKEN_APP_NAME || 'Oko User Token',
      description: 'Wisent automation app for user-scoped Slack API access.',
      background_color: '#1f1f1f',
    },
    oauth_config: {
      scopes: { user: scopes.length ? scopes : DEFAULT_USER_SCOPES },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

async function extractXoxc(page) {
  const configured = readConfiguredXoxc();
  if (configured) {
    console.log('[user-token] using configured Slack web token');
    return configured;
  }

  await page.goto('https://wisent-workspace.slack.com/messages', { waitUntil: 'domcontentloaded' });
  const { humanIdlePause } = await import(`${process.env.WELES_ROOT}/dist/human/mouse.js`);
  await humanIdlePause('long');
  return await page.evaluate(() => {
    if (window.boot_data && window.boot_data.api_token) return window.boot_data.api_token;
    for (let i = 0; i < localStorage.length; i++) {
      const v = localStorage.getItem(localStorage.key(i)) || '';
      const m = v.match(/xoxc-[A-Za-z0-9-]+/);
      if (m) return m[0];
    }
    return '';
  });
}

async function submitInstallForm(page, shot) {
  const { humanIdlePause } = await import(`${process.env.WELES_ROOT}/dist/human/mouse.js`);
  await humanIdlePause('long');
  await shot?.('10-user-oauth-consent');
  const formAction = await page.evaluate(() => document.querySelector('#oauth_install_form')?.action || '');
  const formBody = await page.evaluate(() => {
    const f = document.querySelector('#oauth_install_form');
    if (!f) return '';
    const p = new URLSearchParams();
    f.querySelectorAll('input[type=hidden]').forEach((i) => p.append(i.name, i.value));
    return p.toString();
  });
  if (!formAction || !formBody) throw new Error('[user-token] OAuth consent form not found');
  const allowResp = await page.context().request.post(formAction, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: formBody,
    maxRedirects: 5,
  });
  if (allowResp.status() !== 200 || !allowResp.url().includes('success=1')) {
    throw new Error(`[user-token] OAuth POST rejected: ${allowResp.status()} ${allowResp.url()}`);
  }
}

async function extractXoxpFromOAuthPage(page, appId) {
  const { humanIdlePause } = await import(`${process.env.WELES_ROOT}/dist/human/mouse.js`);
  await page.goto(`https://api.slack.com/apps/${appId}/oauth`, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  console.log('[user-token] OAuth token page loaded; screenshot intentionally skipped');
  return await page.evaluate(() => {
    const values = Array.from(document.querySelectorAll('input,textarea')).map((i) => i.value || '');
    const fromInputs = values.find((value) => /^xoxp-/.test(value));
    if (fromInputs) return fromInputs;
    const m = (document.body.innerText || '').match(/xoxp-[0-9A-Za-z-]+/);
    return m ? m[0] : '';
  });
}

export async function createUserTokenApp({ page, shot, appId: requestedAppId = '' }) {
  const configuredScopes = parseScopes(process.env.SLACK_USER_TOKEN_SCOPES);
  const scopes = configuredScopes.length ? configuredScopes : DEFAULT_USER_SCOPES;

  if (requestedAppId) {
    const existingToken = await extractXoxpFromOAuthPage(page, requestedAppId, shot);
    if (!existingToken) throw new Error(`[user-token] no xoxp token found on OAuth page for app ${requestedAppId}`);
    return { appId: requestedAppId, scopes, token: existingToken, created: false };
  }

  const xoxc = await extractXoxc(page);
  if (!xoxc) throw new Error('[user-token] no xoxc token in window.boot_data or localStorage');
  console.log(`[user-token] xoxc present len=${xoxc.length}`);

  const manifest = JSON.stringify(userTokenManifest(scopes));
  const validateResp = await page.context().request.post('https://slack.com/api/apps.manifest.validate', {
    headers: { Authorization: `Bearer ${xoxc}` },
    multipart: { manifest, token: xoxc },
  });
  const validate = await validateResp.json();
  console.log(`[user-token][validate] ${JSON.stringify(validate).slice(0, 1500)}`);
  if (!validate.ok) throw new Error(`[user-token] apps.manifest.validate failed: ${JSON.stringify(validate).slice(0, 500)}`);

  const createResp = await page.context().request.post('https://slack.com/api/apps.manifest.create', {
    headers: { Authorization: `Bearer ${xoxc}` },
    multipart: { manifest, token: xoxc },
  });
  const create = await createResp.json();
  console.log(`[user-token][create] ${JSON.stringify(create).slice(0, 1500)}`);
  if (!create.ok) throw new Error(`[user-token] apps.manifest.create failed: ${JSON.stringify(create).slice(0, 500)}`);
  const appId = create.app_id;
  if (!appId) throw new Error(`[user-token] apps.manifest.create returned no app_id: ${JSON.stringify(create).slice(0, 200)}`);
  console.log(`[user-token] app created via API: id=${appId}`);
  await shot?.('08-user-app-created');

  await page.goto(`https://api.slack.com/apps/${appId}/install-on-team`, { waitUntil: 'domcontentloaded' });
  const { humanIdlePause } = await import(`${process.env.WELES_ROOT}/dist/human/mouse.js`);
  await humanIdlePause('long');
  const oauthHref = await page.evaluate(() =>
    (Array.from(document.querySelectorAll('a')).find(
      (a) => /install to/i.test(a.textContent || '') && /oauth\/v2\/authorize/.test(a.href),
    ) || {}).href || '',
  );
  if (!oauthHref) throw new Error('[user-token] no Install→OAuth href found on install-on-team page');
  await page.goto(oauthHref, { waitUntil: 'domcontentloaded' });
  await submitInstallForm(page, shot);
  console.log('[user-token] OAuth Allow accepted');

  const token = await extractXoxpFromOAuthPage(page, appId, shot);
  if (!token) throw new Error('[user-token] no xoxp token found on OAuth page');
  return { appId, scopes, token, created: true };
}
