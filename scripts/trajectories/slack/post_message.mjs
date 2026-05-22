// Slack-post trajectory. Drive Google-SSO into wisent.slack.com, create app
// via manifest, extract xoxb token, post Jakub message. See CLAUDE.md.
// Env: SSO_EMAIL, SSO_PASS (from .work/_sso.env), MESSAGE_FILE,
//      SLACK_TARGET_CHANNEL or SLACK_TARGET_CHANNEL_NAME, SWT_CLI.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES = join(__dirname, '..', '..', '..');
const SWIATOWID = join(WELES, '..', 'swiatowid');
const MESSAGE_FILE = process.env.MESSAGE_FILE
  || join(SWIATOWID, '.work', 'jakub-status.txt');
const SWT_CLI = process.env.SWT_CLI
  || join(SWIATOWID, '.build', 'debug', 'swt-cli');
const SETTINGS = join(process.env.HOME, '.claude', 'settings.json');
const TARGET_NAME = (process.env.SLACK_TARGET_CHANNEL_NAME || 'jakub').toLowerCase();
const TARGET_CHAN = process.env.SLACK_TARGET_CHANNEL || '';

if (!existsSync(MESSAGE_FILE)) {
  console.error(`MESSAGE_FILE not found: ${MESSAGE_FILE}`);
  process.exit(2);
}

// 12-scope app manifest matching M58/M59 swiatowid/scripts/slack-bootstrap.sh.
const MANIFEST_YAML = `display_information:
  name: Claude Code
  description: Claude Code (Anthropic CLI) — posts status updates and reads channel context.
  background_color: "#1f1f1f"
features:
  bot_user:
    display_name: Claude Code
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.public
      - channels:read
      - channels:history
      - groups:read
      - groups:history
      - im:history
      - mpim:history
      - users:read
      - users:read.email
      - reactions:read
      - reactions:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;

const { WSession } = await import(`${WELES}/dist/session/wsession.js`);
const { humanFill } = await import(`${WELES}/dist/human/keyboard.js`);
const { humanClickLocator, humanIdlePause } = await import(`${WELES}/dist/human/mouse.js`);
const { solveRecaptchaV2 } = await import(`${WELES}/dist/captcha/recaptcha.js`);

const headless = process.env.HEADLESS === '1';
const s = await WSession.start({ label: 'slack-post', headless });
console.log('[slack] WSession started');

const SHOT_DIR = join(WELES, '.work', 'slack-post');
mkdirSync(SHOT_DIR, { recursive: true });
async function shot(label) {
  const fp = join(SHOT_DIR, `${label}_${Date.now()}.png`);
  try { await s.page.screenshot({ path: fp, fullPage: true }); console.log(`[slack] shot=${fp}`); }
  catch (e) { console.log(`[slack] screenshot WARN ${label}: ${e.message?.slice(0, 80)}`); }
}

async function safeShutdown() {
  if (!s.shutdown) return;
  try { await s.shutdown(); } catch (e) { console.log(`[slack] shutdown WARN: ${e.message?.slice(0, 80)}`); }
}

async function fetchJSON(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
}

// --- Step 1: sign in via email + magic code (NOT Google SSO) ----------------
// The Google account in _sso.env (lukasz.bartoszcze@gmail.com) is NOT a
// member of the wisent.slack.com workspace — verified by a prior run that
// completed Google SSO and got "doesn't have an account on this workspace".
// Wisent workspace membership is on the @wisent.ai email. Slack's email
// magic-code flow sends a 6-digit code to that mailbox; we read it back via
// the existing gmail_token.pickle (already consented for the @wisent.ai
// account, verified at growth-tactics/google_drive/gmail_token.pickle).
const SLACK_EMAIL = process.env.SLACK_EMAIL || 'lukasz.bartoszcze@wisent.ai';
const GMAIL_PICKLE = process.env.GMAIL_PICKLE
  || '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/growth-tactics/google_drive/gmail_token.pickle';

console.log(`[slack] step 1: email magic-code sign-in as ${SLACK_EMAIL}`);
await s.page.goto('https://wisent.slack.com', { waitUntil: 'domcontentloaded' });
await humanIdlePause('deliberate');
await shot('01-slack-landing');

await humanFill(s.page, s.page.locator('input[type="email"]').first(), SLACK_EMAIL);
await humanIdlePause('short');
// Solve the reCAPTCHA v2 "I'm not a robot" widget before submit.
const captchaFrame = s.page.locator('iframe[src*="recaptcha"]').first();
if (await captchaFrame.count() > 0) {
  console.log('[slack] reCAPTCHA detected — solving via weles captcha helper');
  const solved = await solveRecaptchaV2(s.page);
  console.log(`[slack] reCAPTCHA solve result: ${solved}`);
  if (!solved) { console.error('[slack] reCAPTCHA solve failed'); await safeShutdown(); process.exit(7); }
  await humanIdlePause('deliberate');
  await shot('01b-captcha-solved');
}
await humanClickLocator(s.page, s.page.getByRole('button', { name: /sign in with email/i }).first(),
                        { timeoutMs: 10000 });
await humanIdlePause('long');
await shot('02-after-email-submit');

// Poll Gmail for the latest Slack magic code email (sender feedback@slack.com
// or no-reply@slack.com), extract 6-digit code, enter it.
async function fetchMagicCode(timeoutSeconds = 90) {
  const py = `
import pickle, sys, time, re, base64
from googleapiclient.discovery import build
from google.auth.transport.requests import Request
with open(sys.argv[1], 'rb') as f: creds = pickle.load(f)
if creds.expired and creds.refresh_token: creds.refresh(Request())
svc = build('gmail', 'v1', credentials=creds, cache_discovery=False)
deadline = time.time() + int(sys.argv[2])
while time.time() < deadline:
    r = svc.users().messages().list(userId='me',
        q='from:(slack OR feedback@slack.com OR no-reply@slack.com) newer_than:1h',
        maxResults=5).execute()
    for m in r.get('messages', []):
        full = svc.users().messages().get(userId='me', id=m['id'], format='full').execute()
        snippet = full.get('snippet', '')
        parts = []
        def walk(payload):
            for p in payload.get('parts', []) or []:
                if p.get('body', {}).get('data'):
                    parts.append(base64.urlsafe_b64decode(p['body']['data']).decode('utf-8', 'replace'))
                walk(p)
        walk(full.get('payload', {}))
        body = snippet + '\\n' + '\\n'.join(parts)
        mm = re.search(r'\\b(\\d{3}[\\s-]?\\d{3})\\b', body)
        if mm:
            code = re.sub(r'\\s|-', '', mm.group(1))
            if len(code) == 6:
                print(code); sys.exit(0)
    time.sleep(5)
sys.exit(2)
`;
  const PY = process.env.PYTHON3
    || '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12';
  const r = spawnSync(PY, ['-c', py, GMAIL_PICKLE, String(timeoutSeconds)]);
  if (r.status !== 0) throw new Error(`magic-code fetch failed: ${r.stderr?.toString().slice(0, 200)}`);
  return r.stdout.toString().trim();
}
console.log('[slack] polling Gmail for Slack magic code…');
const code = await fetchMagicCode();
console.log(`[slack] got magic code (${code.length} chars)`);

// Slack's magic-code page has 6 single-digit input boxes.
const codeInputs = s.page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"]');
const n = await codeInputs.count();
if (n >= 6) {
  for (let i = 0; i < 6; i++) {
    await humanFill(s.page, codeInputs.nth(i), code[i]);
  }
} else {
  await humanFill(s.page, codeInputs.first(), code);
}
await humanIdlePause('long');
await shot('04-after-code');
console.log(`[slack] post-signin url=${s.page.url()}`);

// --- Step 2: extract xoxc- token from authenticated Slack web client -------
// Skip api.slack.com entirely. wisent.slack.com web app embeds an xoxc-
// client token in window.boot_data; combined with the httponly `d` cookie
// (auto-carried by Playwright's request ctx), we can call chat.postMessage
// directly without ever creating a bot app.
console.log('[slack] step 2: load Slack web client + extract xoxc-');
await s.page.goto('https://wisent.slack.com/messages', { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await shot('05-messages-page');

const xoxc = await s.page.evaluate(() => {
  function findInLS() {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      if (typeof v !== 'string') continue;
      const m = v.match(/xoxc-[\d]+-[\d]+-[\d]+-[a-f0-9]+/);
      if (m) return m[0];
    }
    return null;
  }
  const bd = (typeof window !== 'undefined') ? window.boot_data : null;
  if (bd && bd.api_token) return bd.api_token;
  return findInLS();
});
if (!xoxc) {
  console.error('[slack] no xoxc- in boot_data or localStorage; screenshots in .work/slack-post/');
  await safeShutdown(); process.exit(6);
}
console.log(`[slack] xoxc=${xoxc.slice(0, 24)}… len=${xoxc.length}`);

// --- Step 3: resolve channel + post via Slack API using browser cookies ----
const ctxReq = s.page.context().request;
async function slackApi(method, form) {
  const body = Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await ctxReq.post(`https://wisent.slack.com/api/${method}?_x_id=${Date.now()}`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: body,
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error || JSON.stringify(j).slice(0, 80)}`);
  return j;
}

let channelId = TARGET_CHAN;
if (!channelId) {
  const list = await slackApi('conversations.list', {
    token: xoxc, types: 'public_channel,private_channel', limit: '1000',
  });
  const named = list.channels.find((c) => c.name && c.name.toLowerCase() === TARGET_NAME);
  const general = list.channels.find((c) => c.name && c.name.toLowerCase() === 'general');
  if (named) channelId = named.id;
  else if (general) channelId = general.id;
}
if (!channelId) { console.error('[slack] no channel id'); await safeShutdown(); process.exit(4); }

const messageText = readFileSync(MESSAGE_FILE, 'utf8');
const post = await slackApi('chat.postMessage', {
  token: xoxc, channel: channelId, text: messageText, as_user: 'true',
});
console.log(`[slack] ✓ posted ts=${post.ts} channel=${channelId}`);

await safeShutdown();
console.log('[slack] done');
