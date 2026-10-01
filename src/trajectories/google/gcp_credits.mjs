// Read the GCP Console "Credits" page using the user's signed-in Chrome profile.
//
// Run: node src/trajectories/google/gcp_credits.mjs <BILLING_ACCOUNT_ID>
//
// Resolves the right Chrome profile from ~/.weles/chrome_profiles.json (which
// stores user policy: default email + forbidden_emails) plus Chrome's own
// Local State (which stores user_name + gaia_id per profile dir). Picks the
// profile where `user_name == email AND gaia_id != ""` so stale empty-shell
// profiles (e.g. an old "Profile 34" with the email assigned but never
// actually signed in) get skipped.
//
// Flow:
//   1. Quit any running Chrome (releases user-data-dir lock)
//   2. Launch Chrome.app via macOS `open` with --profile-directory and the URL
//   3. Wait until Chrome reports the tab loaded (AppleScript `loading`),
//      screencapture the window
//   4. Quit Chrome again so the user can restart their normal session
//
// We do NOT drive Chrome via CDP/Playwright here — Chrome.app bundle launching
// fights Playwright's persistent-context handshake. Direct `open` works.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ACCOUNT = process.argv[2] || '017364-D3B657-F207B5';
const TAB = process.env.GCP_CREDITS_TAB || 'issued';
const URL = `https://console.cloud.google.com/billing/${ACCOUNT}/credits`;
const OUT_PNG = '/tmp/gcp_credits.png';
const PROFILES_CFG = join(homedir(), '.weles', 'chrome_profiles.json');

function loadProfilesConfig() {
  if (!existsSync(PROFILES_CFG)) {
    throw new Error(`Profile config missing: ${PROFILES_CFG}. See ~/.weles/chrome_profiles.json template.`);
  }
  return JSON.parse(readFileSync(PROFILES_CFG, 'utf8'));
}

const cfg = loadProfilesConfig();
const USER_DATA_DIR = cfg.user_data_dir.startsWith('~/')
  ? join(homedir(), cfg.user_data_dir.slice(2))
  : cfg.user_data_dir;
const LOCAL_STATE = join(USER_DATA_DIR, 'Local State');

function discoverProfileDir(email) {
  if (!existsSync(LOCAL_STATE)) {
    throw new Error(`Local State missing at ${LOCAL_STATE}`);
  }
  const data = JSON.parse(readFileSync(LOCAL_STATE, 'utf8'));
  const cache = data?.profile?.info_cache || {};
  const target = email.toLowerCase();
  const matches = [];
  for (const [dir, info] of Object.entries(cache)) {
    const userName = (info?.user_name || '').toLowerCase();
    const gaiaId = info?.gaia_id || '';
    if (userName === target && gaiaId !== '') {
      matches.push({ dir, active: info.active_time || 0 });
    }
  }
  matches.sort((a, b) => b.active - a.active);
  return matches[0]?.dir || null;
}

const forbidden = new Set((cfg.forbidden_emails || []).map(s => s.toLowerCase()));
const requestedEmail = (process.env.GCP_PROFILE_EMAIL || cfg.default_email || '').toLowerCase();
const explicitDir = process.env.GCP_PROFILE_DIR;

let PROFILE;
if (explicitDir) {
  PROFILE = explicitDir;
  console.log(`[gcp_credits] using explicit profile dir from env: ${PROFILE}`);
} else {
  if (forbidden.has(requestedEmail)) {
    throw new Error(`Email "${requestedEmail}" is in forbidden_emails (${PROFILES_CFG}).`);
  }
  const dir = discoverProfileDir(requestedEmail);
  if (!dir) {
    throw new Error(`No Chrome profile found for "${requestedEmail}" with non-empty gaia_id in ${LOCAL_STATE}. Profile may not be signed in.`);
  }
  PROFILE = dir;
  console.log(`[gcp_credits] discovered ${requestedEmail} -> ${PROFILE} (Local State)`);
}

function chromeAlive() {
  return spawnSync('pgrep', ['-x', 'Google Chrome']).status === 0;
}

// AppleScript's `quit` returns once Chrome has quit; whatever is still running
// afterwards is killed, and a Chrome that survives that is the error.
function quitChrome() {
  if (!chromeAlive()) return;
  console.log('[gcp_credits] quitting Chrome (graceful)...');
  spawnSync('osascript', ['-e', 'tell application "Google Chrome" to quit']);
  if (!chromeAlive()) return;
  console.log('[gcp_credits] Chrome still running after quit, forcing pkill -9');
  spawnSync('pkill', ['-9', '-f', 'Google Chrome']);
  if (chromeAlive()) throw new Error('Chrome still running after pkill — abort');
}

// Blocks until Chrome reports the active tab of its front window as loaded.
function waitForTabLoaded() {
  const r = spawnSync('osascript', [
    '-e', 'tell application "Google Chrome"',
    '-e', 'repeat until (exists front window)',
    '-e', 'end repeat',
    '-e', 'repeat while (loading of active tab of front window)',
    '-e', 'end repeat',
    '-e', 'end tell',
  ]);
  if (r.status !== 0) throw new Error(`gcp_credits: Chrome did not report the tab state: ${r.stderr?.toString().trim()}`);
}

quitChrome();

console.log(`[gcp_credits] launching Chrome.app (profile=${PROFILE}) -> ${URL}`);

const r = spawnSync('open', [
  '-na', 'Google Chrome', '--args',
  `--profile-directory=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  URL,
]);
if (r.status !== 0) {
  throw new Error(`open failed: ${r.stderr?.toString()}`);
}

console.log('[gcp_credits] waiting for Chrome to report the page loaded...');
waitForTabLoaded();

if (TAB === 'issued') {
  console.log('[gcp_credits] clicking Issued credits tab via injected JS');
  const clickJs = `
    (function(){
      var nodes = Array.from(document.querySelectorAll('a,button,[role="tab"],[role="link"]'));
      var hit = nodes.find(function(n){
        var t = (n.innerText || n.textContent || '').trim().toLowerCase();
        return t === 'issued credits' || t === 'issued' || t.startsWith('issued credits');
      });
      if (hit) { hit.click(); return 'clicked: ' + (hit.innerText||'').slice(0,40); }
      return 'no match';
    })();`.replace(/\s+/g, ' ');
  const r = spawnSync('osascript', [
    '-e', `tell application "Google Chrome" to tell active tab of front window to execute javascript "${clickJs.replace(/"/g, '\\"')}"`,
  ]);
  console.log(`[gcp_credits] tab click result: ${(r.stdout?.toString() || '').trim() || (r.stderr?.toString() || '').trim()}`);
  waitForTabLoaded();
}

spawnSync('osascript', ['-e', 'tell application "Google Chrome" to activate']);

const cap = spawnSync('screencapture', ['-x', OUT_PNG]);
if (cap.status !== 0) {
  throw new Error(`screencapture failed: ${cap.stderr?.toString()}`);
}
console.log(`[gcp_credits] screenshot saved to ${OUT_PNG}`);

console.log('[gcp_credits] quitting Chrome...');
quitChrome();
console.log('[gcp_credits] done.');
