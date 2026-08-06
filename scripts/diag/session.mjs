// Shared diagnosis harness. Used by per-site wrappers (github.mjs, tiktok.mjs).
// Responsibilities: launch weles or stock Chrome with optional proxy, install
// chrome147_stubs + property_trap init scripts BEFORE first navigation, attach
// request/response/nav listeners, poll /tmp/weles-cmd.txt for REPL commands,
// periodic 5s flush with per-frame-URL accumulator so closed iframes survive
// in the final dump, save on SIGINT/SIGTERM.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES_ROOT = join(__dirname, '..', '..');

function operatorCdpConfig() {
  const rawEndpoint = String(process.env.WELES_OPERATOR_CDP_URL || '').trim();
  const token = String(process.env.WELES_OPERATOR_CDP_TOKEN || '').trim();
  if (!rawEndpoint) throw new Error('operator mode requires WELES_OPERATOR_CDP_URL');
  if (Buffer.byteLength(token) < Number('32')) {
    throw new Error('operator mode requires WELES_OPERATOR_CDP_TOKEN with at least 32 bytes');
  }
  for (const siblingName of ['WELES_STADO_OBJECT_API_TOKEN', 'WELES_STADO_MODEL_ROUTER_TOKEN', 'WELES_ARTIFACT_DELIVERY_TOKEN']) {
    const sibling = String(process.env[siblingName] || '').trim();
    if (sibling && sibling === token) {
      throw new Error(`WELES_OPERATOR_CDP_TOKEN must be distinct from ${siblingName}`);
    }
  }
  let endpoint;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error('WELES_OPERATOR_CDP_URL must be a valid URL');
  }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === '::1' || endpoint.hostname === '[::1]';
  const tls = endpoint.protocol === 'https:' || endpoint.protocol === 'wss:';
  const authenticatedLoopback = loopback && (endpoint.protocol === 'http:' || endpoint.protocol === 'ws:');
  if (!tls && !authenticatedLoopback) {
    throw new Error('WELES_OPERATOR_CDP_URL must use TLS, except for authenticated loopback');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('WELES_OPERATOR_CDP_URL must not contain credentials, query, or fragment');
  }
  return { endpoint: endpoint.toString(), token };
}

function buildProxyConfig(url) {
  if (!url) return undefined;
  const u = new URL(url);
  return { server: `${u.protocol}//${u.hostname}:${u.port}`, username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') };
}

export async function runDiag(cfg) {
  const { filter, startUrl, replCommands = {}, label, launch } = cfg;
  if (!filter || !startUrl || !label) throw new Error('runDiag: filter/startUrl/label required');
  const mode = launch || process.env.LAUNCH;
  if (!mode || !['weles', 'chrome', 'operator'].includes(mode)) {
    throw new Error('runDiag requires explicit launch mode: weles, chrome, or secured operator');
  }
  const proxyConfig = buildProxyConfig(process.env.PROXY || '');

  const OUT_DIR = join(process.cwd(), 'recordings');
  mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const OUT = join(OUT_DIR, `${label}_${mode}_${ts}.json`);
  const records = { startedAt: new Date().toISOString(), label, mode, startUrl, requests: [] };
  let seen = 0;

  const TRAP_PATH = join(WELES_ROOT, 'dist', 'diagnostics', 'property_trap.js');
  const TRAP_SCRIPT = existsSync(TRAP_PATH) ? readFileSync(TRAP_PATH, 'utf-8') : null;
  if (!TRAP_SCRIPT) console.log(`[diag] WARN property_trap.js missing at ${TRAP_PATH}`);

  let browser;
  if (mode === 'weles') {
    const WELES_BIN = join(WELES_ROOT, '..', 'chromium-build', 'src', 'out', 'Weles', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    const FP = process.env.WELES_FP || '/tmp/weles-human-fp.json';
    // Auto-generate the fingerprint config if WELES_FP path doesn't exist yet.
    // Without a real config the C++ binary uses raw Chromium defaults — which
    // emits navigator.userAgentData.brands missing the 'Google Chrome' entry,
    // a stable PerimeterX gating signal. Production trajectories pass this via
    // browser/api.ts; the diag harness needs the same data.
    if (!existsSync(FP)) {
      const fpMod = await import(`file://${join(WELES_ROOT, 'dist', 'fingerprint.js')}`);
      const cfg = fpMod.toConfig(fpMod.generate({}));
      const cpp = fpMod.toCppConfig(cfg, 'macos');
      writeFileSync(FP, JSON.stringify(cpp));
      console.log(`[diag] auto-generated FP at ${FP}`);
    }
    const STUBS = readFileSync(join(WELES_ROOT, 'dist', 'scripts', 'chrome147_stubs.js'), 'utf-8');
    console.log(`[diag] launching weles label=${label} fp=${FP} proxy=${!!proxyConfig}`);
    browser = await chromium.launchPersistentContext(`/tmp/weles-diag-${label}`, {
      executablePath: WELES_BIN, headless: false,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-infobars', `--weles-fingerprint=${FP}`, '--lang=en-US'],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: null, proxy: proxyConfig,
    });
    await browser.addInitScript({ content: STUBS });
    if (TRAP_SCRIPT) await browser.addInitScript({ content: TRAP_SCRIPT });
    const p = browser.pages()[0] || await browser.newPage();
    await p.goto(startUrl).catch(e => console.log(`[diag] goto err: ${e.message}`));
  } else if (mode === 'chrome') {
    const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    console.log(`[diag] launching real chrome label=${label} proxy=${!!proxyConfig}`);
    browser = await chromium.launchPersistentContext(`/tmp/chrome-diag-${label}`, {
      executablePath: CHROME_BIN, headless: false,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--disable-infobars'],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: null, proxy: proxyConfig,
    });
    if (TRAP_SCRIPT) await browser.addInitScript({ content: TRAP_SCRIPT });
    const p = browser.pages()[0] || await browser.newPage();
    await p.goto(startUrl).catch(e => console.log(`[diag] goto err: ${e.message}`));
  } else {
    const operator = operatorCdpConfig();
    console.log(`[diag] connecting to secured operator CDP at ${new URL(operator.endpoint).origin}`);
    browser = await chromium.connectOverCDP(operator.endpoint, {
      headers: { Authorization: `Bearer ${operator.token}` },
    });
  }

  function attachPage(page) {
    page.on('request', async (req) => {
      const u = req.url();
      if (!filter.test(u)) return;
      let post = ''; try { post = req.postData()?.slice(0, 4000) || ''; } catch {}
      records.requests.push({ t: Date.now(), phase: 'req', method: req.method(), url: u, headers: req.headers(), postData: post });
      seen++; if (seen % 20 === 0) console.log(`[diag] ${seen} events captured`);
    });
    page.on('response', async (resp) => {
      const u = resp.url();
      if (!filter.test(u)) return;
      let body = ''; try { body = (await resp.text()).slice(0, 8000); } catch {}
      records.requests.push({ t: Date.now(), phase: 'res', status: resp.status(), url: u, headers: resp.headers(), body });
      seen++;
    });
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) { records.requests.push({ t: Date.now(), phase: 'nav', url: f.url() }); console.log(`[diag] nav -> ${f.url().slice(0, 100)}`); } });
  }
  const ctxs = typeof browser.contexts === 'function' ? browser.contexts() : [browser];
  for (const ctx of ctxs) { ctx.on('page', attachPage); for (const page of ctx.pages()) attachPage(page); }

  const frameAccum = new Map();
  setInterval(async () => {
    try {
      const pages = typeof browser.contexts === 'function' ? browser.contexts().flatMap(c => c.pages()) : (browser.pages?.() ?? []);
      for (const p of pages) {
        for (const f of (p.frames?.() ?? [p])) {
          try {
            const j = await f.evaluate('(window.__inst_flush)?window.__inst_flush():"[]"');
            const log = JSON.parse(j);
            const url = f.url?.() ?? '';
            if (!log.length) continue;
            const prev = frameAccum.get(url);
            if (!prev || log.length > prev.log.length) frameAccum.set(url, { url, log });
          } catch {}
        }
      }
      const snapshot = { ...records, accesses: [...frameAccum.values()], endedAt: new Date().toISOString(), totalEvents: records.requests.length };
      writeFileSync(OUT, JSON.stringify(snapshot));
    } catch {}
  }, 5000);

  console.log(`[diag] listening. output will be saved on Ctrl+C: ${OUT}`);

  function finish() {
    records.endedAt = new Date().toISOString(); records.totalEvents = records.requests.length;
    records.accesses = [...frameAccum.values()];
    writeFileSync(OUT, JSON.stringify(records, null, 2));
    console.log(`\n[diag] saved ${records.requests.length} events + ${(records.accesses).reduce((n, a) => n + (a.log?.length ?? 0), 0)} property accesses to ${OUT}`);
    process.exit(0);
  }
  process.on('SIGINT', finish); process.on('SIGTERM', finish);
  setInterval(() => {}, 60000);

  if (mode === 'weles' || mode === 'chrome') {
    const page = browser.pages()[0];
    const CMD_FILE = '/tmp/weles-cmd.txt';
    const ctxForCdp = browser.contexts ? browser.contexts()[0] : browser;
    const cdp = ctxForCdp.newCDPSession ? await ctxForCdp.newCDPSession(page) : null;
    console.log(`[repl] poll file: ${CMD_FILE}. commands: ${Object.keys(replCommands).join(', ')} quit`);
    setInterval(async () => {
      if (!existsSync(CMD_FILE)) return;
      let line = ''; try { line = readFileSync(CMD_FILE, 'utf8').trim(); } catch { return; }
      if (!line) return;
      try { writeFileSync(CMD_FILE, ''); } catch {}
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(' ');
      try {
        if (cmd === 'quit') return finish();
        const fn = replCommands[cmd];
        if (!fn) { console.log(`[repl] unknown cmd: ${cmd}`); return; }
        await fn({ page, cdp, browser, arg, rest });
      } catch (e) { console.log(`[repl] err: ${e.message?.slice(0, 200)}`); }
    }, 500);
  }
  return { browser, records, finish };
}
