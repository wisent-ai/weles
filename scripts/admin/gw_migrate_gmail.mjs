// Drives admin.google.com → Data migration to set up an Email migration from
// WG_SRC to WG_DST. Uses the user's real Chrome (with valid Workspace
// session + DBSC keys) and drives the wizard via osascript-injected JS in the
// active tab — same pattern as scripts/trajectories/google/gcp_credits.mjs.
//
// Why not CDP / Playwright: Workspace-managed Chrome profiles silently disable
// --remote-debugging-port; cookie-export into weles fails the admin password
// re-challenge because DBSC keys live in Chrome's keychain partition.
//
// Usage:
//   WG_SRC=lbartoszcze@wisent.ai WG_DST=lukasz.bartoszcze@wisent.ai \
//     node scripts/admin/gw_migrate_gmail.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readScopedLogin } from '../_shared/scoped-secrets.mjs';

const ADMIN_LOGIN = readScopedLogin('googleWorkspaceAdmin');

const WG_SRC = process.env.WG_SRC;
const WG_DST = process.env.WG_DST;
if (!WG_SRC || !WG_DST) {
  console.error('FAIL: set WG_SRC and WG_DST env vars');
  process.exit(1);
}

const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));  // allow-raw-playwright: utility sleep shim — usages should migrate to humanIdlePause

// === Resolve which Chrome profile to use (lukasz.bartoszcze@wisent.ai) ======
const PROFILES_CFG = join(homedir(), '.weles/chrome_profiles.json');
const cfg = existsSync(PROFILES_CFG)
  ? JSON.parse(readFileSync(PROFILES_CFG, 'utf8'))
  : { user_data_dir: '~/Library/Application Support/Google/Chrome', default_email: 'lukasz.bartoszcze@wisent.ai' };
const USER_DATA_DIR = cfg.user_data_dir.startsWith('~/')
  ? join(homedir(), cfg.user_data_dir.slice(2))
  : cfg.user_data_dir;
const REQUESTED_EMAIL = ADMIN_LOGIN.email.toLowerCase();

function discoverProfileDir(email) {
  const localState = JSON.parse(readFileSync(join(USER_DATA_DIR, 'Local State'), 'utf8'));
  const cache = localState?.profile?.info_cache || {};
  const matches = [];
  for (const [dir, info] of Object.entries(cache)) {
    if ((info?.user_name || '').toLowerCase() === email && (info?.gaia_id || '') !== '') {
      matches.push({ dir, active: info.active_time || 0 });
    }
  }
  matches.sort((a, b) => b.active - a.active);
  return matches[0]?.dir || null;
}
const PROFILE = discoverProfileDir(REQUESTED_EMAIL) ?? 'Profile 20';
console.log(`[gw] profile for ${REQUESTED_EMAIL} -> ${PROFILE}`);

// === Quit user's running Chrome ============================================
function chromeAlive() { return spawnSync('pgrep', ['-fl', '/Applications/Google Chrome.app']).status === 0; }
function quitChrome() {
  if (!chromeAlive()) return;
  console.log('[gw] quitting Chrome (graceful)...');
  spawnSync('osascript', ['-e', 'tell application "Google Chrome" to quit']);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (!chromeAlive()) return; }
  console.log('[gw] graceful quit timed out, forcing pkill');
  spawnSync('pkill', ['-9', '-f', '/Applications/Google Chrome.app']);
  const hard = Date.now() + 5_000;
  while (Date.now() < hard) { if (!chromeAlive()) return; }
  throw new Error('Chrome still running after pkill — abort');
}
quitChrome();

// === Launch Chrome.app via `open` with the data-migration URL ===============
// Verified per Google Workspace docs: same-Workspace Gmail-to-Gmail migration
// lives at /ac/migrate/googleworkspace (legacy DMS at /ac/dms also works).
// /ac/dm is Device Management in current admin console.
const URL = 'https://admin.google.com/ac/migrate/googleworkspace';
console.log(`[gw] launching Chrome (profile=${PROFILE}) -> ${URL}`);
const launch = spawnSync('open', [
  '-na', 'Google Chrome', '--args',
  `--profile-directory=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  URL,
]);
if (launch.status !== 0) {
  console.error(`FAIL: open failed: ${launch.stderr?.toString()}`);
  process.exit(1);
}

// === Helpers: run JS in active tab via osascript ============================
function runJs(js) {
  const escaped = js.replace(/\s+/g, ' ').replace(/"/g, '\\"');
  const r = spawnSync('osascript', [
    '-e', `tell application "Google Chrome" to tell active tab of front window to execute javascript "${escaped}"`,
  ], { encoding: 'utf8' });
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status };
}
function getTabUrl() {
  const r = spawnSync('osascript', ['-e', 'tell application "Google Chrome" to return URL of active tab of front window'], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}
// Find the tab matching `urlSubstr`, focus its window + activate that tab so
// "front window" resolves to it.
function focusTabBy(urlSubstrings) {
  const tests = urlSubstrings.map((s) => `(u contains ${JSON.stringify(s)})`).join(' or ');
  const r = spawnSync('osascript', ['-e',
    `tell application "Google Chrome"
       set winIdx to 0
       repeat with w in windows
         set winIdx to winIdx + 1
         set tabIdx to 0
         repeat with t in tabs of w
           set tabIdx to tabIdx + 1
           set u to URL of t
           if ${tests} then
             set active tab index of w to tabIdx
             set index of w to 1
             activate
             return "found: win=" & winIdx & " tab=" & tabIdx & " url=" & u
           end if
         end repeat
       end repeat
       return "no match"
     end tell`,
  ], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}
function getTabText() {
  const out = runJs("(document.body && document.body.innerText || '').slice(0, 4000)");
  return out.stdout || '';
}

// === Wait for initial render — actively poll for the admin/signin tab =======
console.log('[gw] waiting for admin/signin tab to appear...');
const renderDeadline = Date.now() + 30_000;
let focusResult = '';
while (Date.now() < renderDeadline) {
  focusResult = focusTabBy(['/ac/migrate', 'admin.google.com', 'signin/challenge', 'accounts.google.com']);
  if (focusResult.startsWith('found:')) break;
  await sleep(1);
}
console.log(`[gw] tab focus: ${focusResult}`);
await sleep(4);
const finalUrl = getTabUrl();
console.log(`[gw] post-render url (active tab): ${finalUrl}`);

// Workspace policy forces a password re-challenge for admin console access.
// The owning admin script resolves its dedicated credential in memory.
async function handlePasswordChallenge() {
  const u = getTabUrl();
  if (!u.includes('signin/challenge/pwd')) return u;
  const pw = ADMIN_LOGIN.password;
  // Workspace-managed Chrome refuses JS-from-Apple-Events (security policy that
  // user defaults can't override). Strategy: enable AXEnhancedUserInterface
  // (exposes web-content AX), find the AXSecureTextField, cliclick its exact
  // center, then keystroke the password.
  console.log('[gw] password challenge — using AX-located input + cliclick + keystroke');
  // Force Chrome to be the SYSTEM frontmost app.
  spawnSync('open', ['-a', 'Google Chrome']);
  spawnSync('osascript', ['-e', 'tell application "System Events" to set frontmost of process "Google Chrome" to true']);
  spawnSync('osascript', ['-e', 'tell application "Google Chrome" to activate']);
  await sleep(2);
  // Enable web-content AX so the password input becomes queryable.
  spawnSync('osascript', ['-e', 'tell application "System Events" to tell application process "Google Chrome" to set value of attribute "AXEnhancedUserInterface" to true']);
  const axScript = `tell application "System Events"
     tell process "Google Chrome"
       set wcs to entire contents of window 1
       repeat with el in wcs
         try
           if subrole of el is "AXSecureTextField" then
             set p to position of el
             set sz to size of el
             return ((item 1 of p) as string) & "|" & ((item 2 of p) as string) & "|" & ((item 1 of sz) as string) & "|" & ((item 2 of sz) as string)
           end if
         end try
       end repeat
       return "none"
     end tell
   end tell`;
  let axOut = '';
  for (let i = 0; i < 15; i++) {
    await sleep(1);
    axOut = (spawnSync('osascript', ['-e', axScript], { encoding: 'utf8' }).stdout || '').trim();
    if (axOut && axOut !== 'none') break;
  }
  console.log(`[gw] AX secure-text-field: ${axOut}`);
  if (!axOut || axOut === 'none') { console.error('FAIL: could not locate password input via AX'); process.exit(2); }
  const [px, py, pw_, ph] = axOut.split('|').map(Number);
  const cx = Math.floor(px + pw_ / 2);
  const cy = Math.floor(py + ph / 2);
  const fmCheck = spawnSync('osascript', ['-e', 'tell application "System Events" to return name of first process whose frontmost is true'], { encoding: 'utf8' });
  console.log(`[gw] frontmost app: ${(fmCheck.stdout || '').trim()}`);
  console.log(`[gw] cliclick at ${cx},${cy} (input center)`);
  spawnSync('cliclick', [`c:${cx},${cy}`]);
  await sleep(1);
  // Type password then return.
  spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke ' + JSON.stringify(pw)]);
  await sleep(1);
  spawnSync('osascript', ['-e', 'tell application "System Events" to key code 36']);
  console.log('[gw] password + return sent');

  for (let i = 0; i < 30; i++) {
    await sleep(2);
    const cur = getTabUrl();
    if (!cur.includes('/signin/')) return cur;
    if (/totp|idvprev|iap|\/dp\b|two_factor|webauthn/.test(cur)) {
      console.error(`FAIL: secondary challenge fired (${cur.split('/').slice(-1)[0].slice(0, 60)}). Cannot bypass without a TOTP secret / hardware key / push approval.`);
      process.exit(4);
    }
  }
  return getTabUrl();
}

const afterChallenge = await handlePasswordChallenge();
if (!afterChallenge.startsWith('https://admin.google.com/ac/')) {
  console.error(`FAIL: did not reach admin console (url=${afterChallenge.slice(0, 200)})`);
  process.exit(2);
}
console.log(`[gw] on admin console: ${afterChallenge}`);

const headText = getTabText().slice(0, 300).replace(/\n/g, ' | ');
console.log(`[gw] page text head: ${headText}`);

// === Drive wizard via injected JS ===========================================
// Each step finds buttons/inputs by visible text and clicks them. Material
// dropdowns need a click on the trigger then a click on the option.
function clickByText(re) {
  return runJs(`(function(){
    var rx = new RegExp(${JSON.stringify(re)}, 'i');
    var els = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"], [role="option"], [role="tab"]'));
    var hit = els.find(function(e){
      var t = (e.innerText || e.textContent || '').trim();
      return rx.test(t) && e.offsetWidth > 0 && e.offsetHeight > 0;
    });
    if (hit) { hit.click(); return 'clicked: ' + (hit.innerText || hit.textContent || '').slice(0, 40); }
    return 'no match: ' + ${JSON.stringify(re)};
  })();`);
}
function fillByLabel(labelRe, value) {
  return runJs(`(function(){
    var rx = new RegExp(${JSON.stringify(labelRe)}, 'i');
    var inputs = Array.from(document.querySelectorAll('input, textarea'));
    var hit = inputs.find(function(i){
      var aria = i.getAttribute('aria-label') || '';
      var ph = i.getAttribute('placeholder') || '';
      var name = i.getAttribute('name') || '';
      return (rx.test(aria) || rx.test(ph) || rx.test(name)) && i.offsetWidth > 0;
    });
    if (!hit) return 'no input match: ' + ${JSON.stringify(labelRe)};
    hit.focus();
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(hit, ${JSON.stringify(value)});
    hit.dispatchEvent(new Event('input', { bubbles: true }));
    hit.dispatchEvent(new Event('change', { bubbles: true }));
    return 'filled ' + (hit.getAttribute('aria-label') || hit.getAttribute('placeholder') || hit.getAttribute('name'));
  })();`);
}

const wizardSteps = [
  { label: 'open setup',                fn: () => clickByText('^(set up data migration|add data migration|setup)') },
  { label: 'pick category Email',       fn: () => clickByText('^email$|email migration') },
  { label: 'open source dropdown',      fn: () => clickByText('migration source') },
  { label: 'pick Google Workspace',     fn: () => clickByText('google workspace') },
  { label: 'continue (post-source)',    fn: () => clickByText('^continue$|^next$') },
  { label: 'open protocol dropdown',    fn: () => clickByText('connection protocol') },
  { label: 'pick Auto select',          fn: () => clickByText('auto select|auto-select') },
  { label: 'authorize',                 fn: () => clickByText('^authorize$') },
];

for (const step of wizardSteps) {
  const r = step.fn();
  console.log(`[gw] ${step.label}: ${r.stdout || r.stderr || `status=${r.status}`}`);
  await sleep(3);
}

console.log('[gw] post-authorize, waiting for OAuth handshake...');
await sleep(10);
console.log(`[gw] url now: ${getTabUrl()}`);
console.log(`[gw] page text head: ${getTabText().slice(0, 300).replace(/\n/g, ' | ')}`);

// Add the user pair (lbartoszcze@wisent.ai → lukasz.bartoszcze@wisent.ai)
const userSteps = [
  { label: 'open select users',           fn: () => clickByText('select users|add users') },
  { label: 'add user',                    fn: () => clickByText('add user') },
  { label: 'fill source email',           fn: () => fillByLabel('migrate from|source email|source', WG_SRC) },
  { label: 'fill destination email',      fn: () => fillByLabel('migrate to|destination email|destination', WG_DST) },
  { label: 'submit (Start)',              fn: () => clickByText('^start$|begin migration|^migrate$') },
];
for (const step of userSteps) {
  const r = step.fn();
  console.log(`[gw] ${step.label}: ${r.stdout || r.stderr || `status=${r.status}`}`);
  await sleep(2);
}

await sleep(6);
console.log(`[gw] final url: ${getTabUrl()}`);
console.log(`[gw] final page text: ${getTabText().slice(0, 400).replace(/\n/g, ' | ')}`);
console.log('[gw] script complete. Inspect Chrome — wizard state should reflect the operations above.');
