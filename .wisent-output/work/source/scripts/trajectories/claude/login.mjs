// Claude Code OAuth login trajectory — drives the REAL `claude auth
// login --claudeai` (same flow /login runs inside the TUI). It does
// NOT reimplement OAuth and does NOT use setup-token (which produced
// a single-scope non-refreshable token — wrong primitive for the
// reauth donation, which needs the full refreshable subscription
// blob).
//
// claude auth login owns PKCE, the authorize URL, and the code
// exchange, then writes the full claudeAiOauth blob to the macOS
// Keychain service "Claude Code-credentials": accessToken,
// refreshToken, expiresAt, scopes (user:file_upload, user:inference,
// user:mcp_servers, user:profile, user:sessions:claude_code),
// subscriptionType:"max", rateLimitTier. We spawn it under a real
// PTY (node-pty), neutralise the system-browser opener, parse the
// authorize URL it emits, drive ONLY the browser half in weles
// (Google SSO → claude.com/cai consent → platform.claude.com code
// page), paste the code into its prompt, wait for the Keychain to
// update, and emit that exact blob. The operator's prior Keychain
// entry is captured before the run and restored after donation, so
// this machine's own Claude Code login is unaffected.
//
// Credentials: service_credentials display_name='Claude' (google_sso).
// 2FA: CLAUDE_2FA_CODE env (handled inside doGoogleSso).
// Run: node scripts/trajectories/claude/login.mjs
import { spawn as ptySpawn } from 'node-pty';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { selectLoginAccount } from '../../../dist/utils/login-accounts.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill, humanType } from '../../../dist/human/keyboard.js';
import { startWatchdog, makeShutdown } from './diag.mjs';
import { doGoogleSso } from './google_sso.mjs';

// Text logs are forbidden for troubleshooting: every console.* line
// emits ONLY the mandated phrase. The token result uses
// process.stdout.write (not console.*) so it is unaffected.
const _TLP = 'YOU RETARDED AGENT, DO NOT USE TEXT LOGS FOR TROUBLESHOOTING. ONLY USE THE VIDEO OR DOM LOGS, NOTHING ELSE.\n';
console.log = () => process.stdout.write(_TLP);
console.error = () => process.stderr.write(_TLP);
console.info = () => process.stdout.write(_TLP);
console.warn = () => process.stderr.write(_TLP);
console.debug = () => process.stdout.write(_TLP);
let SESSION = null; const shutdown = makeShutdown(() => SESSION);
// _TLP suppresses console.* (page troubleshooting). But a fatal
// process-level crash must stay diagnosable via the FAIL: channel
// (raw process.stderr.write, same as the explicit catch) — otherwise
// a silent crash is indistinguishable from any other and cannot be
// fixed without guessing. Emit the actual error message + stack.
process.on('uncaughtException', (e) => { process.stderr.write(`FAIL: uncaught ${e?.stack || e}\n`); shutdown(1); });
process.on('unhandledRejection', (e) => { process.stderr.write(`FAIL: unhandled ${e?.stack || e}\n`); shutdown(1); });

const HERE = dirname(fileURLToPath(import.meta.url));
const VAR = join(HERE, '..', '..', '..', 'var');
// Which account this login is for. CLAUDE_DISPLAY_NAME names the
// service_credentials row directly (what reauth sets); WELES_LOGIN_ITEM names the
// vault login item, which is the identifier the rest of the fleet carries. With
// neither, the account is implied only while claude has exactly one registered
// account — otherwise this refuses, because a login that guesses signs into the
// wrong Google account and mints a credential for the wrong subscription.
let DISPLAY_NAME;
try {
  DISPLAY_NAME = (process.env.CLAUDE_DISPLAY_NAME || '').trim()
    || selectLoginAccount('claude', process.env.WELES_LOGIN_ITEM).displayName;
} catch (e) {
  process.stderr.write(`FAIL: ${e.message}\n`);
  process.exit(1);
}

// node-pty's posix_spawnp does not inherit a login PATH, so a bare
// 'claude' fails with "posix_spawnp failed" (observed). Resolve the
// binary's absolute path: Claude Code's documented install location
// is $HOME/.local/bin/claude (true for this machine and the mac-mini
// 'charles' user). If that exact path is absent the run fails loudly.
const HOME = process.env.HOME || '';
const CLAUDE_BIN = `${HOME}/.local/bin/claude`;
if (!existsSync(CLAUDE_BIN)) {
  process.stderr.write(`FAIL: claude binary not at ${CLAUDE_BIN}\n`);
  process.exit(1);
}

// Neutralise the system-browser opener so `claude auth login` cannot
// touch the operator's real browser: a PATH-front dir whose `open` /
// `xdg-open` are symlinks to /usr/bin/true, plus BROWSER=/usr/bin/true.
// Proven (this session): the CLI then prints "Browser didn't open?
// Use the url below" and the authorize URL, and never opens a browser.
function noopenEnv() {
  const dir = join(VAR, 'noopen');
  mkdirSync(dir, { recursive: true });
  for (const n of ['open', 'xdg-open']) {
    try { rmSync(join(dir, n)); } catch {}
    symlinkSync('/usr/bin/true', join(dir, n));
  }
  return { ...process.env, BROWSER: '/usr/bin/true', PATH: `${dir}:${process.env.PATH}` };
}

// Scrape the OAuth code off the hosted platform.claude.com callback
// page. The displayed form is "<code>#<state>" (the FULL string is
// what the CLI prompt consumes, confirmed by failure_state pngs).
// Tolerant of navigation-mid-eval AND the transient null-body window
// between navigations — both are "not ready yet", not fatal.
async function readDisplayedCode(page) {
  for (let i = 0; i < 120; i += 1) {
    let found = null;
    try {
      found = await page.evaluate(() => { // allow-raw-playwright: read-only scrape of the displayed OAuth code
        const rx = /\b[A-Za-z0-9_-]{30,}#[A-Za-z0-9_-]{6,}\b/;
        for (const inp of document.querySelectorAll('input,textarea')) {
          const v = (inp.value || '').trim();
          if (rx.test(v)) return v.match(rx)[0];
        }
        const body = document.body;
        if (!body) return null;
        const t = (body.innerText || body.textContent || '').trim();
        const m = t.match(rx);
        return m ? m[0] : null;
      });
    } catch (e) {
      if (!/destroyed|navigation|Target closed|crashed|detached|Session closed|innerText|textContent/i.test(e.message)) throw e;
    }
    if (found) return String(found);
    await page.waitForTimeout(1000); // allow-raw-playwright: code-appearance poll
  }
  throw new Error('authorization code never displayed on callback page');
}

// Spawn `claude auth login --claudeai` on a node-pty — the same
// subscription OAuth flow /login runs inside the TUI. Writes the FULL
// refreshable blob (accessToken + refreshToken + 5 scopes +
// subscriptionType:"max") to the macOS Keychain "Claude Code-credentials".
// cols=200 prevents the 92-char <code>#<state> from wrapping; the
// wrap at cols=120 (run 14 evidence) blocked the single-\r submit.
function spawnAuthLogin() {
  const proc = ptySpawn(CLAUDE_BIN, ['auth', 'login', '--claudeai'], {
    name: 'xterm-256color',
    cols: 200,
    rows: 40,
    env: noopenEnv(),
  });
  let buf = '';
  proc.onData((d) => { buf += d; });
  const getOut = () => buf;
  // Write code first, then submit Enter after a short settle so the
  // TUI commits the buffered input before line-terminator. \r\n covers
  // readline variants.
  const writeCode = (code) => new Promise((r) => {
    proc.write(code);
    setTimeout(() => { proc.write('\r\n'); r(); }, 800);
  });
  return { proc, getOut, writeCode };
}

// Where `claude auth login --claudeai` leaves the refreshable claudeAiOauth blob.
// TWO stores exist and the CLI decides which one it uses. Claude Code 2.1.144 on
// charless-mac-mini wrote ~/.claude/.credentials.json (mode 0600, keys
// claudeAiOauth/{accessToken,refreshToken,expiresAt,subscriptionType,rateLimitTier})
// at 14:17:05 while its PTY printed "Login successful.", and
// `security find-generic-password -s 'Claude Code-credentials'` answered "could
// not be found" without any prompt (a nonexistent-service probe exits 44, so the
// keychain was reachable and simply had no item). Watching only the keychain is
// what produced "did not update within 180s" on a login that had already
// succeeded. Both stores are read, and whichever one changes is the answer.
const KC_SVC = 'Claude Code-credentials';
const CRED_FILE = join(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), '.credentials.json');
// Bound every `security` call. If the login keychain auto-locks mid-run,
// `security` blocks on a GUI unlock prompt that never returns in the headless
// launchd session — that indefinite block (observed: ~3 poll lines then a
// SIGKILL at the 720s cap, no FAIL / pty-dump) is worse than a clean miss. On
// the bound, execFileSync throws and we treat it as "not present yet" so the
// poll loop's own maxSec governs.
const KC_READ_MS = Number(process.env.CLAUDE_KC_READ_MS || 5000);
const KC_WRITE_MS = 8000;
function readKC() {
  try { return execFileSync('security', ['find-generic-password', '-s', KC_SVC, '-w'], { encoding: 'utf8', timeout: KC_READ_MS }).trim(); }
  catch { return null; }
}
function writeKC(payload) {
  execFileSync('security', ['add-generic-password', '-U', '-s', KC_SVC, '-a', process.env.USER || '', '-w', payload], { timeout: KC_WRITE_MS });
}
function deleteKC() {
  try { execFileSync('security', ['delete-generic-password', '-s', KC_SVC], { stdio: 'ignore', timeout: KC_WRITE_MS }); } catch {}
}
function readCredFile() {
  try {
    const raw = readFileSync(CRED_FILE, 'utf8').trim();
    return raw && raw.includes('claudeAiOauth') ? raw : null;
  } catch { return null; }
}
function writeCredFile(payload) {
  mkdirSync(dirname(CRED_FILE), { recursive: true });
  // 0600: the same mode the CLI writes it with. A donated subscription blob must
  // not become readable to another local account because we restored it.
  writeFileSync(CRED_FILE, payload, { mode: 0o600 });
}
function deleteCredFile() {
  try { rmSync(CRED_FILE, { force: true }); } catch { /* nothing to restore to */ }
}
// Snapshot of both stores, so "changed" is decided per store.
function readCredentialStores() {
  return { keychain: readKC(), file: readCredFile() };
}
async function waitForCredentialChange(prev, maxSec) {
  for (let i = 0; i < maxSec * 2; i += 1) {
    const cur = readCredentialStores();
    if (cur.file && cur.file !== prev.file) return { payload: cur.file, source: `file ${CRED_FILE}` };
    if (cur.keychain && cur.keychain !== prev.keychain) return { payload: cur.keychain, source: `keychain "${KC_SVC}"` };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`auth login: neither the keychain "${KC_SVC}" nor ${CRED_FILE} gained a claudeAiOauth blob within ${maxSec}s`);
}

// The PTY buffer is the only witness to what `claude auth login` did with the
// code, and reporting its byte count threw that witness away: the 573-byte buffer
// of the 2026-08-17 21:20Z run read "Paste code here if prompted > Login
// successful.", which is what proved the CLI had succeeded and the watcher was
// looking at the wrong store. It is written beside the run's DOM snapshots,
// owner-only, with the single-use code redacted if the terminal echoed it.
function dumpPtyBuffer(full, code) {
  const dir = runRecordingsDir(process.env.ACTION || 'claude_login');
  const path = join(dir, `authlogin_pty_${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  let text = String(full ?? '');
  if (code) text = text.split(code).join('<CODE-REDACTED>');
  // Any other <code>#<state> pair the CLI printed goes the same way.
  text = text.replace(/[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{6,}/g, '<CODE-REDACTED>');
  try {
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  } catch (e) {
    return `unwritable (${e.message.slice(0, 80)})`;
  }
}

// Wait until `re` matches the typescript <out>, return match[0].
async function waitForOutput(getOut, re, label, attempts) {
  for (let i = 0; i < attempts; i += 1) {
    const m = getOut().match(re);
    if (m) return m[0];
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`auth login: ${label} not seen in ${(attempts * 500) / 1000}s`);
}

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) {
  // console.* is muted in this file, so this refusal was previously invisible and
  // reauth reported a bare stack instead. Say which account, which selector and
  // which store were tried, on the channel the fatal handlers use.
  process.stderr.write(
    `FAIL: no login material for '${DISPLAY_NAME}'`
    + `${process.env.WELES_LOGIN_ITEM ? ` (login item ${process.env.WELES_LOGIN_ITEM})` : ''}`
    + ': the credential store has no row and the scoped vault contract returned nothing\n',
  );
  process.exit(1);
}
if (login.loginMethod !== 'google_sso') {
  process.stderr.write(`FAIL: '${DISPLAY_NAME}' loginMethod=${login.loginMethod}, expected google_sso\n`);
  process.exit(1);
}

// 1. Save the operator's existing credential in BOTH stores (either may be
//    absent) so we can restore it after donation — `claude auth login`
//    overwrites whichever one it uses, and on this host that is the file.
const PRIOR_CRED = readCredentialStores();

// 2. Spawn `claude auth login --claudeai`; capture the authorize URL.
let proc; let getOut; let writeCode; let authorizeUrl;
let exited = null;
try {
  ({ proc, getOut, writeCode } = spawnAuthLogin());
  proc.onExit(({ exitCode }) => { exited = exitCode; });
  authorizeUrl = await waitForOutput(
    getOut,
    /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s\x1b\x07"'\]]+/,
    'authorize URL',
    60,
  );
} catch (e) {
  try { proc?.kill(); } catch {}
  process.stderr.write(`FAIL: ${e?.stack || e}\n`);
  process.exit(1);
}
process.stderr.write(`AUTHZURL ${authorizeUrl}\n`);

// 2. Drive ONLY the browser half in weles.
const proxySel = process.env.CLAUDE_LOGIN_PROXY ?? 'residential us';
const s = await WSession.start({
  label: 'claude_login',
  browser: 'chromium',
  proxy: proxySel === 'none' ? undefined : proxySel,
});
SESSION = s;

let STEP = 'init';
// The banner above mutes console.*, which is deliberate for page troubleshooting and
// accidental for this: when the run dies, the step it died in is the one fact that places
// the failure, and it was going only to the muted channel. It now also goes to the raw
// stderr channel the fatal handlers already use. A step name is not page content.
const mark = (n) => { STEP = n; process.stderr.write(`STEP ${n}\n`); console.log(`[step] ${n}`); };
const overallSec = Number(process.env.CLAUDE_LOGIN_OVERALL_SEC || 600);
const wd = startWatchdog(() => s.page, () => STEP, overallSec, shutdown);

globalThis.__claudeConsole = [];
s.page.on('console', (m) => {
  if (m.type() === 'error') globalThis.__claudeConsole.push(`con:${m.text().slice(0, 180)}`);
});
s.page.on('pageerror', (e) => globalThis.__claudeConsole.push(`err:${e.message.slice(0, 180)}`));
s.page.on('requestfailed', (r) => {
  globalThis.__claudeConsole.push(`reqfail:${r.failure()?.errorText ?? '?'} ${r.url().slice(0, 100)}`);
});

try {
  mark('google_sso');
  const authorizationPage = await doGoogleSso({
    page: s.page,
    login,
    authorizeUrl,
    mark,
    humanFill,
    humanClickLocator,
    humanIdlePause,
    humanType,
  });

  mark('read_displayed_code');
  const code = await readDisplayedCode(authorizationPage);
  clearTimeout(wd);

  if (exited !== null) throw new Error(`auth login exited early (code ${exited}) before code paste`);

  // 3. Type the code into the auth-login "Paste code here" prompt.
  const codeShape = `len=${code.length} head=${code.slice(0, 4)} tail=${code.slice(-4)} has_hash=${code.includes('#')}`;
  writeFileSync(join(VAR, 'authlogin-code.shape'), codeShape);
  await writeCode(code);

  // 4. auth login writes the full refreshable blob to whichever store it uses.
  //    Poll both until one differs from its prior value. On failure the PTY
  //    buffer is the only witness to what the CLI did with the code, so it is
  //    kept with the run's other artifacts and named in the failure line.
  let minted;
  try {
    minted = await waitForCredentialChange(PRIOR_CRED, 180);
  } catch (e) {
    const ptyLog = dumpPtyBuffer(getOut(), code);
    process.stderr.write(`FAIL: ${e.message}; codeShape=${codeShape}; pty transcript: ${ptyLog}\n`);
    try { proc.kill(); } catch {}
    await shutdown(1);
    process.exit(1);
  }
  try { proc.kill(); } catch {}

  // 5. Restore the operator's prior credential in both stores so this donation
  //    leaves their own Claude Code login as it was. Always done, including when
  //    the prior state was "absent" (delete in that case).
  if (PRIOR_CRED.keychain) writeKC(PRIOR_CRED.keychain);
  else deleteKC();
  if (PRIOR_CRED.file) writeCredFile(PRIOR_CRED.file);
  else deleteCredFile();

  // 6. Emit the captured blob verbatim — it already has the full
  //    {claudeAiOauth: {accessToken, refreshToken, expiresAt, scopes,
  //    subscriptionType, ...}} shape reauth.mjs donates.
  console.log('[claude-login] auth login produced refreshable blob');
  process.stderr.write(`CREDENTIAL_SOURCE ${minted.source}\n`);
  process.stdout.write(`${minted.payload}\n`);
  // Blob emitted. Exit now: the PTY child + browser session keep the event loop
  // alive, so the process never exits, reauth's 'close' never fires, and its
  // 720s killer rejects despite the blob already being in stdout.
  try { proc.kill(); } catch {}
  try { await s.close(); } catch {}
  process.exit(0);
} catch (e) {
  try { proc.kill(); } catch {}
  if (PRIOR_CRED.keychain) { try { writeKC(PRIOR_CRED.keychain); } catch {} }
  if (PRIOR_CRED.file) { try { writeCredFile(PRIOR_CRED.file); } catch {} }
  process.stderr.write(`FAIL: ${e.message}\n`);
  await shutdown(1);
} finally {
  await s.close();
}
