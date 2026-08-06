// Persistent-browser keeper backed by weles infrastructure (WSession + humanized atoms).
// Sidecar talks via Unix socket — no CDP debug port. Bookkeeping in bookkeeping.mjs.
// Env: SESSION, PLATFORM, URL, JAR, HEADLESS, BROWSER, KEEPER_FLOW_ACTION.

import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { enforceWelesServicePlacement } from './service-placement.mjs';

enforceWelesServicePlacement('keeper/keeper.mjs');

const REPO = process.env.WELES_REPO || '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles';
const { WSession } = await import(`${REPO}/dist/session/wsession.js`);
const { getSocialAccount, resolveAccountSession } = await import(`${REPO}/dist/utils/credentials.js`);
const { generatePersona } = await import(`${REPO}/dist/browser/persona.js`);
const { humanType, humanFill } = await import(`${REPO}/dist/human/keyboard.js`);
const { humanClickLocator, humanClick, humanScroll, humanMove, humanIdlePause } = await import(`${REPO}/dist/human/mouse.js`);
const { wsSaveAccount } = await import(`${REPO}/dist/session/wsession-helpers/finalize.js`);
const { solveRecaptchaV2 } = await import(`${REPO}/dist/captcha/recaptcha.js`);
const { captureVersions } = await import(`${REPO}/dist/diagnostics/versions.js`);
const { uploadArtifacts } = await import(`${REPO}/dist/worker/upload-artifacts.js`);
const { readChallengeOutcome } = await import(`${REPO}/dist/diagnostics/run-import.js`);
const { setupKeeperFlow } = await import('./bookkeeping.mjs');

const SESSION = process.env.SESSION || 'default';
const PLATFORM = process.env.PLATFORM || '';
const URL_ARG = process.env.URL || '';
const JAR_PATH = process.env.JAR || '';
const HEADLESS = process.env.HEADLESS === '1';
const USER_DATA_DIR = process.env.KEEPER_USER_DATA_DIR || process.env.WELES_USER_DATA_DIR || '';
const STAY_ALIVE_ON_SIGTERM = process.env.KEEPER_STAY_ALIVE_ON_SIGTERM === '1';
// Optional engine pin for debugging a specific browser (e.g. verifying the
// Firefox fingerprint). Only applied when no PLATFORM persona is sourced.
const BROWSER = process.env.BROWSER || '';
const DIAGNOSTIC_STAGE = process.env.DIAGNOSTIC_STAGE || process.env.WELES_DIAGNOSTIC_STAGE || '';

const KEEPER_DIR = join(homedir(), '.weles', 'keeper', SESSION);
mkdirSync(KEEPER_DIR, { recursive: true });
const SOCK_PATH = join(KEEPER_DIR, 'socket');
if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
process.on('exit', () => {
  try { if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH); } catch {}
});

let proxy, persona, acct = null;
if (PLATFORM) {
  acct = await getSocialAccount(PLATFORM);
  if (acct) {
    const opts = await resolveAccountSession(acct);
    proxy = opts.proxyUrl;
    persona = opts.persona;
    console.log(`[keeper:${SESSION}] account=${acct.username} proxy=${proxy ? 'set' : 'none'}`);
  } else {
    console.log(`[keeper:${SESSION}] PLATFORM=${PLATFORM} but no account — anonymous context`);
  }
}
if (!proxy && process.env.PROXY_URL) {
  proxy = process.env.PROXY_URL;
  console.log(`[keeper:${SESSION}] using PROXY_URL env override`);
}
// Geo-match tz/language to the proxy exit. Previous (account-bound) runs got this
// from the account persona; an anonymous keeper has none, so it would leak the
// HOST timezone (a US IP + Europe/Warsaw clock is a hard tell). Generate a persona
// from the exit country (PROXY_COUNTRY, default US) — honest-host then overrides
// the HARDWARE fields (GPU/cores/RAM/screen) on top, leaving tz/lang/Accept-Language
// matched to the exit. PERSONA_OS pins the family to the real host (default macos).
if (!persona) {
  const _country = process.env.PROXY_COUNTRY || 'US';
  persona = generatePersona({ country: _country, os: process.env.PERSONA_OS || 'macos', browser: BROWSER || 'chromium' });
  console.log(`[keeper:${SESSION}] generated persona country=${_country} os=${persona.os} tz=${persona.timezone} lang=${persona.language} (honest-host overrides hardware)`);
}

const KEEPER_FLOW_ACTION = process.env.KEEPER_FLOW_ACTION || (PLATFORM ? `${PLATFORM}_keeper` : 'keeper_flow');
let s = null;
const flow = await setupKeeperFlow({
  session: SESSION,
  platform: PLATFORM || null,
  action: KEEPER_FLOW_ACTION,
  accountId: acct?.id ?? null,
  proxyUrl: proxy ?? null,
  sessionMeta: { provider: 'keeper', proxy_url: proxy ?? null, platform: PLATFORM || null },
  diagnostic: DIAGNOSTIC_STAGE ? {
    stage: DIAGNOSTIC_STAGE,
    source: process.env.DIAGNOSTIC_SOURCE || 'keeper_env',
    execution_mode: 'keeper_human_capture',
    fixed_axes: (process.env.DIAGNOSTIC_FIXED_AXES || '').split(',').map(s => s.trim()).filter(Boolean),
    variable_axis: process.env.DIAGNOSTIC_VARIABLE_AXIS || '',
  } : null,
  captureVersionsFn: captureVersions,
  uploadArtifactsFn: uploadArtifacts,
  challengeOutcomeFn: readChallengeOutcome,
  getLastUrl: () => s?.page?.url?.() ?? null,
  closeSessionFn: async () => {
    if (!s) return;
    try { await s.close(); }
    catch (e) { console.log(`[keeper:${SESSION}] s.close err: ${e?.message?.slice(0, 100) ?? String(e).slice(0, 100)}`); }
  },
});
if (flow.rowId) console.log(`[keeper:${SESSION}] bookkeeping row=${flow.rowId.slice(0, 8)} action=${KEEPER_FLOW_ACTION}`);
if (flow.rowId) {
  process.env.ACTION_LOG_ID = flow.rowId;
  process.env.WELES_RUN_ID = flow.rowId;
}
process.env.ACTION = KEEPER_FLOW_ACTION;
if (STAY_ALIVE_ON_SIGTERM) {
  process.removeAllListeners('SIGTERM');
  process.on('SIGTERM', () => console.log(`[keeper:${SESSION}] ignoring SIGTERM because KEEPER_STAY_ALIVE_ON_SIGTERM=1`));
}

// Run CLEAN by default: page-visible JS traps (property_trap, surface_inventory,
// fingerprint_hooks, input_recorder) are themselves the detection tells (non-native
// getters) — injecting them contaminated the keeper's own anti-detect tests. HAR /
// network capture is decoupled (CDP-level, undetectable) so forensics survive.
// Opt back into the page traps with KEEPER_PAGE_TRAPS=1 for deliberate forensic runs.
const _keeperTraps = process.env.KEEPER_PAGE_TRAPS === '1';
s = await WSession.start({ label: `keeper-${SESSION}`, proxy, persona, headless: HEADLESS, browser: BROWSER || undefined, os: process.env.PERSONA_OS || undefined, pageDiagnostics: _keeperTraps, userDataDir: USER_DATA_DIR || undefined });
if (STAY_ALIVE_ON_SIGTERM) {
  process.removeAllListeners('SIGTERM');
  process.on('SIGTERM', () => console.log(`[keeper:${SESSION}] ignoring SIGTERM because KEEPER_STAY_ALIVE_ON_SIGTERM=1`));
}
console.log(`[keeper:${SESSION}] page traps ${_keeperTraps ? 'ON (forensic)' : 'OFF (clean)'}`);
if (USER_DATA_DIR) console.log(`[keeper:${SESSION}] userDataDir=${USER_DATA_DIR}`);
console.log(`[keeper:${SESSION}] WSession started`);

// Force the password sign-in path: make WebAuthn unavailable so Google never
// fires its native passkey dialog (a browser-chrome dialog Playwright cannot
// click). With it gone, Google presents the password field directly. Gated on
// KEEPER_DISABLE_WEBAUTHN=1 so normal keeper runs are unaffected.
if (process.env.KEEPER_DISABLE_WEBAUTHN === '1') {
  try {
    await s.ctx.addInitScript(() => {
      try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); } catch (e) {}
      try { if (navigator.credentials) { navigator.credentials.get = () => Promise.reject(new DOMException('webauthn disabled', 'NotAllowedError')); } } catch (e) {}
    });
    console.log(`[keeper:${SESSION}] WebAuthn disabled (KEEPER_DISABLE_WEBAUTHN=1) — Google offers password instead of passkey`);
  } catch (e) { console.log(`[keeper:${SESSION}] webauthn disable err: ${e?.message?.slice(0, 80)}`); }
}

// Auto-finalize when the operator closes the browser window. Without this the
// keeper parks on its idle socket loop and the row stays status='running' with
// nothing uploaded — the diagnostic executor finalizes on window-close (it polls
// page.isClosed()), the keeper had no equivalent. flow.close() flushes the
// .inst.json (via wsClose), uploads artifacts, imports provenance, and writes the
// SQL capture. Best-effort completed/failed: authenticated (li_at) => completed.
let _finalizing = false;
let _lastKnownUrl = URL_ARG || null;
const _rememberUrl = () => {
  try {
    const u = s?.page?.url?.();
    if (u && u !== 'about:blank') _lastKnownUrl = u;
  } catch {}
};
let _rememberUrlTimer = null;
async function finalizeOnWindowClose(via) {
  if (_finalizing) return;            // page/ctx/browser events fire near-simultaneously
  if (STAY_ALIVE_ON_SIGTERM && via === 'page_close') {
    _finalizing = true;
    console.log(`[keeper:${SESSION}] page closed (${via}) — reopening because KEEPER_STAY_ALIVE_ON_SIGTERM=1`);
    try {
      const nextPage = await s.ctx.newPage();
      s.page = nextPage;
      attachPageCloseHandler(nextPage);
      if (_lastKnownUrl) {
        await nextPage.goto(_lastKnownUrl, { waitUntil: 'domcontentloaded' }).catch((e) =>
          console.log(`[keeper:${SESSION}] reopen goto warn: ${e.message?.slice(0, 80)}`)
        );
      }
      console.log(`[keeper:${SESSION}] reopened at ${s.page.url()}`);
    } catch (e) {
      console.log(`[keeper:${SESSION}] reopen after page close failed: ${e?.message?.slice(0, 120) ?? String(e)}`);
    } finally {
      _finalizing = false;
    }
    return;
  }
  _finalizing = true;
  if (_rememberUrlTimer) clearInterval(_rememberUrlTimer);
  let lastUrl = null, authed = false;
  try { lastUrl = s?.page?.url?.() ?? null; } catch { /* context torn down */ }
  // Capture the FULL session (cookies + localStorage) before the context tears
  // down. li_at's VALUE — not just its presence — is the difference between a
  // reusable account and a checkmark; persist the storageState to the run dir so
  // a completed run yields a session you can resume, and the network capture
  // (which redacts cookie headers) isn't the only record.
  try {
    const state = await s.ctx.storageState();
    authed = (state.cookies || []).some((c) => c.name === 'li_at');
    if (authed && flow.rowId) {
      const dir = join(process.env.RECORDINGS_ROOT || 'recordings', flow.rowId);
      try { mkdirSync(dir, { recursive: true }); } catch {}
      try { writeFileSync(join(dir, 'storage_state.json'), JSON.stringify(state)); } catch {}
      console.log(`[keeper:${SESSION}] saved storage_state.json (${(state.cookies || []).length} cookies, li_at present)`);
    }
  } catch { /* ctx already gone — best effort */ }
  const status = authed ? 'completed' : 'failed';
  console.log(`[keeper:${SESSION}] window closed (${via}) — finalizing as ${status} (li_at=${authed})`);
  try {
    await flow.close(status, { healthy: authed, signal: authed ? 'keeper_completed' : 'keeper_window_closed', details: { last_url: lastUrl, via } }, null);
  } catch (e) { console.log(`[keeper:${SESSION}] window-close finalize threw: ${e?.message?.slice(0, 120) ?? String(e)}`); }
  process.exit(0);
}
function attachPageCloseHandler(page) {
  try { page.on('framenavigated', _rememberUrl); } catch {}
  try { page.on('close', () => { void finalizeOnWindowClose('page_close'); }); } catch {}
}
attachPageCloseHandler(s.page);
try { s.ctx.on('close', () => { void finalizeOnWindowClose('ctx_close'); }); } catch {}
try { s.ctx.browser?.()?.on('disconnected', () => { void finalizeOnWindowClose('browser_disconnected'); }); } catch {}
_rememberUrlTimer = setInterval(_rememberUrl, 2000);

// Cookie injection: explicit JAR path wins, else use account's metadata.cookies.
if (JAR_PATH && existsSync(JAR_PATH)) {
  try {
    const raw = JSON.parse(readFileSync(JAR_PATH, 'utf8'));
    const cookies = Array.isArray(raw) ? raw : (raw.cookies || []);
    if (cookies.length) await s.ctx.addCookies(cookies);
    console.log(`[keeper:${SESSION}] injected ${cookies.length} cookies from ${JAR_PATH}`);
  } catch (e) { console.log(`[keeper:${SESSION}] jar err: ${e.message?.slice(0, 80)}`); }
} else if (acct?.metadata?.cookies?.length) {
  try {
    const cs = acct.metadata.cookies.filter(c => c.name && c.value).map(c => ({
      ...c,
      sameSite: c.sameSite === 'no_restriction' ? 'None'
              : c.sameSite === 'lax' ? 'Lax'
              : c.sameSite === 'strict' ? 'Strict' : 'Lax',
    }));
    if (cs.length) await s.ctx.addCookies(cs);
    console.log(`[keeper:${SESSION}] injected ${cs.length} cookies from account`);
  } catch (e) { console.log(`[keeper:${SESSION}] cookie inject err: ${e.message?.slice(0, 80)}`); }
}

if (URL_ARG) {
  await s.page.goto(URL_ARG, { waitUntil: 'domcontentloaded' }).catch((e) =>
    console.log(`[keeper:${SESSION}] goto warn: ${e.message?.slice(0, 80)}`)
  );
  console.log(`[keeper:${SESSION}] at ${s.page.url()}`);
}

// Command dispatch lives in eval_guard.mjs (kept here would push this file over
// the 300-line limit). Bind it to the live session + bookkeeping flow.
const { makeDispatch } = await import('./eval_guard.mjs');
const dispatch = makeDispatch({ s, flow, SESSION });

const server = net.createServer((conn) => {
  let buf = '';
  conn.on('error', (e) => console.log(`[keeper:${SESSION}] socket client err: ${e.message?.slice(0, 120) ?? String(e)}`));
  conn.on('close', () => { conn.__keeperClosed = true; });
  conn.on('data', async (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const cmd = JSON.parse(line);
        const res = await dispatch(cmd);
        if (!conn.destroyed && !conn.__keeperClosed) {
          conn.write(JSON.stringify(res) + '\n', (e) => {
            if (e) console.log(`[keeper:${SESSION}] socket write err: ${e.message?.slice(0, 120) ?? String(e)}`);
          });
        }
      } catch (e) {
        if (!conn.destroyed && !conn.__keeperClosed) {
          conn.write(JSON.stringify({ ok: false, error: e.message?.slice(0, 200) }) + '\n', (writeErr) => {
            if (writeErr) console.log(`[keeper:${SESSION}] socket error-response write err: ${writeErr.message?.slice(0, 120) ?? String(writeErr)}`);
          });
        }
      }
    }
  });
});
server.listen(SOCK_PATH, () => {
  console.log(`[keeper:${SESSION}] listening on ${SOCK_PATH}`);
  console.log(`[keeper:${SESSION}] === IDLE — drive via SESSION=${SESSION} node action.mjs <cmd> ===`);
});

await new Promise(() => {});
