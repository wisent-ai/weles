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
//   3. Wait for the page to render, screencapture the window
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

function quitChrome() {
  if (!chromeAlive()) return;
  console.log('[gcp_credits] quitting Chrome (graceful)...');
  spawnSync('osascript', ['-e', 'tell application "Google Chrome" to quit']);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (!chromeAlive()) return; }
  console.log('[gcp_credits] graceful quit timed out, forcing pkill -9');
  spawnSync('pkill', ['-9', '-f', 'Google Chrome']);
  const hard = Date.now() + 5_000;
  while (Date.now() < hard) { if (!chromeAlive()) return; }
  throw new Error('Chrome still running after pkill — abort');
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

console.log('[gcp_credits] waiting for initial render...');
const renderDeadline = Date.now() + 30_000;
while (Date.now() < renderDeadline) {}

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
  const settle = Date.now() + 6_000;
  while (Date.now() < settle) {}
}

spawnSync('osascript', ['-e', 'tell application "Google Chrome" to activate']);
const focusDeadline = Date.now() + 1_500;
while (Date.now() < focusDeadline) {}

const cap = spawnSync('screencapture', ['-x', OUT_PNG]);
if (cap.status !== 0) {
  throw new Error(`screencapture failed: ${cap.stderr?.toString()}`);
}
console.log(`[gcp_credits] screenshot saved to ${OUT_PNG}`);

console.log('[gcp_credits] quitting Chrome...');
spawnSync('osascript', ['-e', 'tell application "Google Chrome" to quit']);
const finalDeadline = Date.now() + 8_000;
while (Date.now() < finalDeadline) { if (!chromeAlive()) break; }
if (chromeAlive()) {
  spawnSync('pkill', ['-9', '-f', 'Google Chrome']);
}
console.log('[gcp_credits] done.');
