// Claude Code OAuth login trajectory — drives the REAL `claude
// setup-token`, it does NOT reimplement OAuth.
//
// `claude setup-token` (v2.1.144) owns PKCE, the authorize URL, the
// code exchange, and prints a long-lived (~1y, scope=user:inference)
// token to stdout — it stores nothing, so it never clobbers this
// machine's own Claude Code login. We spawn it under a PTY (BSD
// `script`) with the system-browser opener neutralised, parse the
// authorize URL it emits, drive ONLY the browser half in weles
// (Google SSO → claude.com/cai consent → hosted platform.claude.com
// code page), read the displayed code, and write it back to
// setup-token's "Paste code here" stdin prompt. The token it then
// prints is wrapped in the claudeAiOauth blob shape reauth.mjs
// donates. No genPkce / no authorizeUrl build / no token endpoint.
//
// Credentials: service_credentials display_name='Claude' (google_sso).
// 2FA: CLAUDE_2FA_CODE env (handled inside doGoogleSso).
// Run: node scripts/trajectories/claude/login.mjs
import { spawn as ptySpawn } from 'node-pty';
import { mkdirSync, symlinkSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServiceLogin } from '../../../dist/utils/credentials.js';
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
const DISPLAY_NAME = process.env.CLAUDE_DISPLAY_NAME || 'Claude';

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

// Neutralise the system-browser opener so `claude setup-token` cannot
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
// page. Form is "<code>#<state>"; setup-token wants the part before #.
// Tolerates both navigation-mid-eval ("context destroyed") AND the
// transient null-body window between navigations (document.body is
// null until the new DOM attaches) — both are "not ready yet", not
// fatal. Treat any evaluate exception as "keep polling".
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
    // Hosted callback displays "<code>#<state>" with the instruction
    // "Paste this into Claude Code:" — setup-token consumes the FULL
    // string (failure-state png ac321021 from run 12 captured this
    // verbatim). Do NOT split on '#'.
    if (found) return String(found);
    await page.waitForTimeout(1000); // allow-raw-playwright: code-appearance poll
  }
  throw new Error('authorization code never displayed on callback page');
}

// Spawn the real `claude setup-token` on a REAL pty via node-pty.
// `script` is unusable from node (it tcgetattr()s its stdin, which is
// always a pipe/socket under child_process → "Operation not supported
// on socket", exit 1, 0-byte output — observed). node-pty allocates a
// genuine pty/openpty pair so the TUI renders and accepts input.
// getOut() returns the accumulated pty output; writeCode() feeds the
// pasted code into the "Paste code here" prompt.
function spawnSetupToken() {
  // cols=200 keeps the 92-char OAuth code on a single visual line —
  // run 14 wrapped at cols=120 (92 asterisks across 2 lines) and the
  // single \r never triggered submit, so setup-token sat idle past
  // the 90s wait with no error and no token. Width prevents the wrap.
  const proc = ptySpawn(CLAUDE_BIN, ['setup-token'], {
    name: 'xterm-256color',
    cols: 200,
    rows: 40,
    env: noopenEnv(),
  });
  let buf = '';
  proc.onData((d) => { buf += d; });
  const getOut = () => buf;
  // Write code first, then submit Enter after a short settle so the
  // TUI commits the buffered input before line-terminator. Send both
  // \r and \n to cover readline variants. \x1b[F is a no-op safety
  // (move to start of line); harmless in canonical mode.
  const writeCode = (code) => new Promise((r) => {
    proc.write(code);
    setTimeout(() => { proc.write('\r\n'); r(); }, 800);
  });
  return { proc, getOut, writeCode };
}

// Wait until `re` matches the typescript <out>, return match[0].
async function waitForOutput(getOut, re, label, attempts) {
  for (let i = 0; i < attempts; i += 1) {
    const m = getOut().match(re);
    if (m) return m[0];
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`setup-token: ${label} not seen in ${(attempts * 500) / 1000}s`);
}

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) { console.log(`FAIL: no '${DISPLAY_NAME}' row`); process.exit(1); }
if (login.loginMethod !== 'google_sso') {
  process.stderr.write(`FAIL: '${DISPLAY_NAME}' loginMethod=${login.loginMethod}, expected google_sso\n`);
  process.exit(1);
}

// 1. Real claude setup-token owns the OAuth; capture the URL it emits.
//    Wrapped so a spawn/parse failure is a diagnosable FAIL line, not
//    a silent top-level unhandledRejection.
let proc; let getOut; let writeCode; let authorizeUrl;
let exited = null;
try {
  ({ proc, getOut, writeCode } = spawnSetupToken());
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
const mark = (n) => { STEP = n; console.log(`[step] ${n}`); };
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
  await doGoogleSso({
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
  const code = await readDisplayedCode(s.page);
  clearTimeout(wd);

  if (exited !== null) throw new Error(`setup-token exited early (code ${exited}) before code paste`);

  // 3. Hand the code to the real setup-token's stdin prompt. It does
  //    its own PKCE exchange and prints the long-lived token.
  mark('paste_code_to_setup_token');
  // Persist the scraped code shape (len + first/last bytes — NOT the
  // full code, which is a one-time secret) and the setup-token PTY
  // buffer to var/. If the token-wait fails, the dump pins whether
  // setup-token rejected the code (visible in the PTY tail) or never
  // saw it (empty post-paste). The in-memory buffer would otherwise
  // vanish on exit and leave the failure opaque.
  const codeShape = `len=${code.length} head=${code.slice(0, 4)} tail=${code.slice(-4)} has_hash=${code.includes('#')}`;
  writeFileSync(join(VAR, 'setuptoken-code.shape'), codeShape);
  await writeCode(code);

  let token;
  try {
    token = await waitForOutput(
      getOut,
      /sk-ant-[A-Za-z0-9_-]{20,}/,
      'printed token after code paste',
      // PKCE token exchange takes a few seconds end-to-end; 90s is
      // generous so a slow exchange is not mistaken for a failure.
      180,
    );
  } catch (e) {
    // Dump the FULL pty buffer (not just the tail) so setup-token's
    // actual error response is captured — run 12 showed only the
    // prompt + masked-input asterisks within 2000 bytes, with the
    // real response off-buffer.
    const full = getOut();
    writeFileSync(join(VAR, 'setuptoken-pty-full.dump'), full);
    process.stderr.write(`FAIL: ${e.message}; codeShape=${codeShape}; pty_full_bytes=${full.length}\n`);
    try { proc.kill(); } catch {}
    await shutdown(1);
    process.exit(1);
  }

  // 4. Wrap the real CLI's token in the claudeAiOauth blob shape
  //    reauth.mjs donates. setup-token issues a ~1y, scope
  //    user:inference token and no refresh token (Anthropic docs).
  const blob = {
    claudeAiOauth: {
      accessToken: token,
      refreshToken: null,
      expiresAt: Date.now() + 364 * 24 * 60 * 60 * 1000,
      scopes: ['user:inference'],
      source: 'claude setup-token',
      accountEmail: login.email,
    },
  };
  try { proc.kill(); } catch {}
  console.log('[claude-login] setup-token produced token');
  process.stdout.write(`${JSON.stringify(blob)}\n`);
} catch (e) {
  try { proc.kill(); } catch {}
  process.stderr.write(`FAIL: ${e.message}\n`);
  await shutdown(1);
} finally {
  await s.close();
}
