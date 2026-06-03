/**
 * WSession — unified high-level API for weles browser automation.
 * Every method uses shared modules. Agent tools map 1:1 to these methods.
 */

import { type BrowserContext, chromium } from 'playwright'; import { AsyncNewBrowser, type AsyncNewBrowserOptions } from '../async_api.js';
import { type Persona, generatePersona } from '../browser/persona.js';
import { SessionStore } from './store.js';
import { Capture } from '../capture/capture.js';
import { findClickTarget, askPage, checkPage, type ScreenshottablePage } from '../vision/analyze.js';
import { humanClick, humanClickLocator } from '../human/mouse.js';
import { humanType } from '../human/keyboard.js';
import { selectOption } from '../human/select.js';
import { waitCloudflare } from '../cloudflare/challenge.js';
import { solvePageCaptcha } from '../captcha/detect.js';
import { CaptchaSolver } from '../captcha/solver.js';
import { generateIdentity as genId, type Identity } from '../utils/identity.js';
import { markSignupSuccess } from '../utils/email/domain.js';
import { getNumber, pollCode, type SmsNumber } from '../utils/sms.js';
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startInstrumentation } from './wsession-helpers/net_record.js';
import { join } from 'node:path';
import { resolveProxy } from '../proxy/config.js';
import { seedHumanTiming } from '../utils/timing.js';
import { getEmailApiKey } from '../utils/credentials.js';
import { findCustomBrowser } from './find_browser.js';
import { costTracker } from '../utils/cost.js';

import { installAtoms } from './wsession_atoms.js';  // installAtoms() is invoked at file end after WSession is declared
function recordingsDir(label?: string): string { const d = join(process.cwd(), 'recordings', ...(label ? [label] : [])); mkdirSync(d, { recursive: true }); return d; }

// G2: effective behavior-changing env vars snapshotted at session start. The
// list is intentionally generous — any flag that alters input path, browser
// selection/registration, instrumentation, recording, diagnostics, LinkedIn
// egress policy, or proxy-pool wiring. Reads process.env directly so the value
// reflects the live process at session start; unset flags surface as undefined.
const ENV_FLAG_KEYS = [
  'WELES_INPUT', 'WELES_INSTANT_INPUT', 'WELES_REGISTER_BROWSER',
  'WELES_ENABLE_CHROME147_STUBS', 'WELES_DISABLE_HTTP2', 'WELES_USE_STOCK_CHROMIUM',
  'WELES_NO_INSTRUMENT', 'WELES_FULL_DIAGNOSTICS', 'WELES_PCAP_DIAGNOSTICS',
  'WELES_DISABLE_RECORDING', 'WELES_ALLOW_LINKEDIN_DIRECT', 'WELES_ALLOW_LINKEDIN_RESIDENTIAL',
  'WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY', 'LINKEDIN_REGISTER_PREWARM_URLS',
  'DECODO_ISP_PORTS', 'DECODO_ISP_PORT', 'DECODO_ISP_HOST', 'CHROMIUM_PATH',
  'WELES_FORCE_PROXY', 'WELES_ALLOW_PLAYWRIGHT_FIREFOX',
  'WELES_CAPTURE_RESPONSE_BODIES', 'WELES_HOST_DIAGNOSTICS', 'WELES_STORAGE_DIAGNOSTICS',
  'WELES_CDP_DIAGNOSTICS', 'WELES_CDP_FIREHOSE', 'WELES_CHROMIUM_NETLOG',
  'WELES_PROXY_DIAGNOSTICS_LABEL', 'WELES_NOPECHA_EXT', 'WELES_USER_DATA_DIR',
  'WELES_CACHE_DIR',
] as const;
function snapshotEnvFlags(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_FLAG_KEYS) out[k] = process.env[k];
  return out;
}

// G15: full runner env snapshot — EVERY key with its RAW value, so the exact
// environment a run executed under is fully recoverable. session_meta.json and
// the account_action_logs rows are readable only by service-role-key holders
// (the recordings bucket is private), i.e. the same trust boundary as the
// secrets themselves — storing them here adds no exposure beyond who already
// holds every key.
function snapshotFullEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export interface WSessionOptions {
  label?: string;
  proxy?: string;
  chromiumPath?: string;
  userDataDir?: string;
  headless?: boolean;
  record?: boolean;
  cdpEndpoint?: string;
  targetHost?: string;
  os?: string;
  locale?: string;
  persona?: Persona;
  browser?: string;
  pageDiagnostics?: boolean;
  // When set, WSession.start auto-invokes generateIdentity(platform) and
  // attaches the result to ws.identity. Register trajectories should pass
  // their platform here instead of importing generateIdentity themselves.
  platform?: string;
}

function redactProxyForLog(proxy: unknown): string {
  if (!proxy) return 'undefined';
  if (typeof proxy === 'string') {
    try {
      const u = new URL(proxy);
      if (u.username) u.username = `${decodeURIComponent(u.username).slice(0, 18)}...`;
      if (u.password) u.password = '***';
      return u.toString();
    } catch {
      return '[proxy]';
    }
  }
  if (typeof proxy === 'object') {
    const p = proxy as { server?: string; username?: string; password?: string };
    return JSON.stringify({
      server: p.server,
      username: p.username ? `${p.username.slice(0, 18)}...` : undefined,
      password: p.password ? '***' : undefined,
    });
  }
  return String(proxy);
}

function hashDiagnosticValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function countryHintFromProxyRequest(proxy: unknown): string | undefined {
  if (typeof proxy !== 'string' || proxy.startsWith('http') || proxy.startsWith('socks')) return undefined;
  const countryTokens = new Set(['us', 'uk', 'gb', 'br', 'de', 'fr', 'nl', 'ca', 'au']);
  const tokens = proxy.toLowerCase().match(/\b[a-z]{2}\b/g) ?? [];
  const cc = tokens.find(t => countryTokens.has(t));
  return cc?.toUpperCase();
}

function resolveChromiumPathOverride(optsPath?: string): string | undefined {
  const candidates = [
    optsPath,
    process.env.CHROMIUM_PATH,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const p of candidates) {
    if (existsSync(p)) return p;
    console.log(`[wsession] ignoring missing Chromium path: ${p}`);
  }
  return findCustomBrowser('chromium');
}

function shouldCaptureResponseBody(res: any): boolean {
  try {
    if (process.env.WELES_CAPTURE_RESPONSE_BODIES !== '1') return false;
    const req = res.request?.();
    const resourceType = req?.resourceType?.();
    if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) return false;
    const headers = res.headers?.() ?? {};
    const contentType = String(headers['content-type'] ?? '').toLowerCase();
    if (contentType && !/json|text|javascript|xml|html|x-www-form-urlencoded/.test(contentType)) return false;
    const len = Number(headers['content-length'] ?? 0);
    return !len || len <= 256 * 1024;
  } catch {
    return false;
  }
}

const asV = (p: any) => p as unknown as ScreenshottablePage;

export class WSession {
  readonly page: any;
  readonly ctx: BrowserContext;
  readonly label: string;
  private _cap: Capture;
  private _store: SessionStore;
  private _solver: CaptchaSolver;
  private _env: Record<string, string> = {};

  private _step = 0;
  captchaResponse: any = null;
  captchaFormData: any = null;
  authBlocked: string | null = null;
  captchaHeaders: Record<string, string> = {};
  captchaEndpoint: string = '';
  proxyConfig: { server: string; username?: string; password?: string; country?: string; exit_ip?: string; platform?: string } | undefined;
  personaConfig: Persona | undefined;
  // Identity assigned by WSession.start when opts.platform is set; eliminates
  // per-trajectory generateIdentity + field-rename boilerplate.
  identity: { firstName: string; lastName: string; username: string; email: string; password: string; birthMonth: string; birthDay: string; birthYear: string } | undefined;
  capturedResponses: Array<{ ts: number; method: string; url: string; status: number; headers: Record<string, string>; body: string }> = [];
  private _smsOrder: SmsNumber | null = null;
  private _proxyBytes = 0;
  private _cdp: any = null;

  private constructor(ctx: BrowserContext, page: any, label: string, cap: Capture) {
    this.ctx = ctx; this.page = page; this.label = label; this._cap = cap;
    this._store = new SessionStore(); this._solver = new CaptchaSolver();
    // Intercept API responses to capture captcha data (Discord register + login)
    const authPaths = ['/auth/register', '/auth/login'];
    page.on?.('request', (req: any) => { try { const u = req.url(); if (authPaths.some(p => u.includes(p)) && req.method() === 'POST') { this.captchaFormData = JSON.parse(req.postData() ?? '{}'); this.captchaEndpoint = u; const h = req.headers(); this.captchaHeaders = {}; for (const k of Object.keys(h)) { if (k.startsWith('x-')) this.captchaHeaders[k] = h[k]; } } } catch {} });
    page.on?.('response', async (res: any) => { try { const u = res.url(); if (authPaths.some(p => u.includes(p)) && res.status() >= 400) { const d = await res.json(); if (d.captcha_key !== undefined) { this.captchaResponse = d; console.log(`[wsession] Captured captcha data: sitekey=${d.captcha_sitekey?.slice(0, 12)}`); } const errs = d?.errors?.login?._errors ?? d?.errors?.email?._errors ?? []; const code = errs[0]?.code; if (code === 'ACCOUNT_PERMANENTLY_DISABLED' || code === 'ACCOUNT_DISABLED' || code === 'ACCOUNT_LOGIN_BLOCKED') { this.authBlocked = code; console.log(`[wsession] Auth blocked by platform: ${code}`); } } } catch {} });
    ctx.on?.('response', (res: any) => {
      try {
        if (this.capturedResponses.length >= 500) this.capturedResponses.shift();
        const entry = { ts: Date.now(), method: res.request()?.method?.() ?? 'GET', url: res.url(), status: res.status(), headers: res.headers(), body: '' };
        this.capturedResponses.push(entry);
        if (!shouldCaptureResponseBody(res)) return;
        void res.text().then((text: string) => { entry.body = text.slice(0, 8192); }, () => {});
      } catch {}
    });
    // CDP Network.dataReceived — accumulates bytes flowing through the proxy
    // upstream so we can compute per-trajectory egress cost in close().
    void (async () => {
      try {
        if (typeof ctx.newCDPSession !== 'function') return;
        this._cdp = await ctx.newCDPSession(page);
        await this._cdp.send('Network.enable').catch(() => {});
        this._cdp.on('Network.dataReceived', (e: any) => {
          // encodedDataLength is on-the-wire bytes (post-compression). Falls
          // back to dataLength for older Chromium revisions.
          const n = Number(e?.encodedDataLength ?? e?.dataLength ?? 0);
          if (n > 0) this._proxyBytes += n;
        });
      } catch (e: any) { console.log(`[wsession] CDP attach err: ${e.message?.slice(0, 120)}`); }
    })();
  }

  async runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const n = String(this._step++).padStart(3, '0');
    const label = `${n}_${name.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}`;
    const url = (typeof this.page.url === 'function' ? this.page.url() : '') ?? '';
    const closed = this.page.isClosed?.() ?? false;
    const vs = this.page.viewportSize?.() ?? {};
    console.log(`[wsession] ${label} START url=${url.slice(0, 80)} closed=${closed} viewport=${vs.width}x${vs.height}`);
    await this._cap.screenshot(this.page, `before_${label}`).catch(() => {});
    await this._saveDom(`before_${label}`);
    try {
      const result = await fn();
      console.log(`[wsession] ${label} OK result=${String(result).slice(0, 100)}`);
      await this._cap.screenshot(this.page, `after_${label}`).catch(() => {});
      await this._saveDom(`after_${label}`);
      return result;
    } catch (e: any) {
      console.log(`[wsession] ${label} ERROR ${e.message?.slice(0, 300)}`);
      await this._cap.screenshot(this.page, `error_${label}`).catch(() => {});
      await this._saveDom(`error_${label}`);
      throw e;
    }
  }

  private async _saveDom(label: string): Promise<void> { const html = await this.page.content?.().catch(() => null); if (html) writeFileSync(join(recordingsDir(this.label || undefined), `${label}_dom.html`), html); }

  static async start(opts: WSessionOptions = {}): Promise<WSession> {
    const label = opts.label ?? '';
    // G9: one per-run human-timing seed, generated at session start and routed
    // into the shared seeded PRNG so every human mouse/typing jitter draw this
    // run is reproducible from the recorded seed. Unseeded code paths fall back
    // to Math.random, so this only makes behavior reproducible — it does not
    // change the statistical distribution. Recorded into session_meta as a
    // required non-null number (result.run.timing_seed).
    const timingSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0);
    seedHumanTiming(timingSeed);
    const cdp = opts.cdpEndpoint ?? process.env.BRIGHTDATA_BROWSER_WS;
    console.log(`[wsession] start() label=${label} cdp=${!!cdp} proxy=${redactProxyForLog(opts.proxy)}`);
    if (label) process.env.WELES_LABEL = label;
    if (cdp) {
      const browser = await chromium.connectOverCDP(cdp);
      const ctx = browser.contexts()[0] || await browser.newContext({ locale: 'en-US' }); const page = ctx.pages()[0] || await ctx.newPage();
      return new WSession(ctx, page, label, new Capture({ newPage: async () => page } as any, label ? recordingsDir(label) : undefined));
    }
    const proxyRequested = !!opts.proxy && !['none', 'direct'].includes(String(opts.proxy).toLowerCase());
    const persona: Persona = opts.persona ?? generatePersona({ country: countryHintFromProxyRequest(opts.proxy), os: opts.os as Persona['os'] | undefined, browser: opts.browser as Persona['browser'] | undefined });
    const proxy = proxyRequested ? await resolveProxy(opts.proxy!, opts.targetHost, persona) : undefined;
    if (proxyRequested && !proxy) {
      throw new Error(`proxy_unavailable: requested ${opts.proxy} for ${opts.targetHost ?? 'unknown target'}`);
    }
    const pageDiagnostics = opts.pageDiagnostics ?? (label !== 'linkedin_register');
    const bOpts: AsyncNewBrowserOptions = { os: persona.os, browser: persona.browser, headless: opts.headless ?? false, recordVideo: opts.record ?? (process.env.WELES_DISABLE_RECORDING !== '1'), locale: opts.locale, persona, proxy, pageDiagnostics, userDataDir: opts.userDataDir ?? process.env.WELES_USER_DATA_DIR };
    const cp = bOpts.browser === 'chromium'
      ? resolveChromiumPathOverride(opts.chromiumPath)
      : (opts.chromiumPath ?? process.env.CHROMIUM_PATH ?? findCustomBrowser(bOpts.browser));
    if (bOpts.browser === 'chromium' && !cp) throw new Error('Custom Chromium not found. Set CHROMIUM_PATH or install to a known location.');
    if (cp && bOpts.browser === 'chromium') bOpts.chromiumPath = cp;
    if (label) { process.env.SSLKEYLOGFILE = join(recordingsDir(label), 'sslkey.log'); process.env.WELES_LABEL = label; } // SSLKEYLOGFILE = per-session key log for offline HTTP/2 frame decryption from a pcap (Chromium+Firefox both honor it). WELES_LABEL tells async_api where optional Chromium netlog.json belongs. recordingsDir() also mkdirs the parent so Chrome can write at launch.
    const ctx = await AsyncNewBrowser(bOpts);
    const page = ctx.pages()[0] || await ctx.newPage();
    const cap = new Capture({ newPage: async () => page } as any, label ? recordingsDir(label) : undefined);
    if (label) { const s = new SessionStore(); await s.injectPlaywright(ctx, label).catch(() => {}); }
    const ws = new WSession(ctx, page, label, cap); ws.proxyConfig = bOpts.proxy; ws.personaConfig = persona; (ws as any)._browserProvenance = (ctx as any)._welesBrowserProvenance ?? null;
    if (opts.platform) { ws.identity = await genId(opts.platform); console.log(`[wsession] identity generated platform=${opts.platform} username_hash=${hashDiagnosticValue(ws.identity.username)}`); }
    if (bOpts.proxy?.server) {
      try {
        const r = await ctx.request.get('https://api.ipify.org', { timeout: 10_000 });
        if (r.ok()) { const t = (await r.text()).trim(); if (/^[0-9a-fA-F.:]+$/.test(t)) (bOpts.proxy as any).exit_ip = t; }
      } catch {}
    }
    // G14: write provenance for EVERY labelled run, proxied or not. The whole
    // block used to be gated on bOpts.proxy?.server, so direct (no-proxy)
    // browser runs recorded none of it. Proxy-derived fields are now optional.
    if (label) {
      try {
        const u = bOpts.proxy?.server ? new URL(bOpts.proxy.server) : null;
        // Full per-run fingerprint provenance (G1): the randomized source
        // persona AND the realized fingerprint actually presented (UA, full
        // UA-CH brand list, navigator/screen/webgl), copied verbatim into
        // account_action_logs.result.session by the worker importer.
        // persona + realized_fingerprint are typed REQUIRED + non-null so a
        // future edit cannot silently drop them to null: persona is always
        // generated, and async_api always attaches a realized fingerprint.
        const meta: {
          proxy_host?: string; proxy_port?: string; proxy_user_present: boolean;
          proxy_user_hash: unknown; exit_ip: unknown; platform: unknown; provider: unknown;
          browser_provenance: unknown; persona: Persona; realized_fingerprint: Record<string, unknown>;
          env_flags: Record<string, string | undefined>;
          env_all: Record<string, string>;
          sticky_session_id?: string; sticky_hash?: string;
          exit_reputation?: import('../proxy/policy.js').ExitReputation;
          identity?: Identity;
          timing_seed: number;
          started_at: string;
        } = {
          proxy_host: u?.hostname,
          proxy_port: u?.port,
          proxy_user_present: !!bOpts.proxy?.username,
          proxy_user_hash: hashDiagnosticValue(bOpts.proxy?.username),
          exit_ip: bOpts.proxy?.exit_ip,
          platform: bOpts.proxy?.platform,
          provider: (bOpts.proxy as any)?.provider,
          browser_provenance: (ws as any)._browserProvenance,
          persona,
          realized_fingerprint: (ctx as any)._welesFingerprintConfig,
          // G2: snapshot the effective behavior-changing env vars at session
          // start so a run's exact mode (input path, browser registration,
          // diagnostics, LinkedIn egress policy, proxy pool wiring) is queryable.
          // Required Record (never null); individual flags are undefined when
          // unset — that absence is itself meaningful provenance.
          env_flags: snapshotEnvFlags(),
          // G15: the COMPLETE runner env (all keys), secret values redacted.
          env_all: snapshotFullEnv(),
          // G4: which sticky exit this session pinned to. Undefined for
          // non-sticky / url-form proxies (legitimately — only sticky-capable
          // providers populate it), so it is NOT forced non-null.
          sticky_session_id: (bOpts.proxy as any)?.sticky_session_id,
          sticky_hash: (bOpts.proxy as any)?.sticky_hash,
          // G11: full ip-api enrichment of the winning exit IP (ASN, ISP/org,
          // reverse-DNS, region/city/geo, proxy/hosting/mobile flags). Optional
          // — ip-api can fail or the run may have no exit IP.
          exit_reputation: (bOpts.proxy as any)?.exit_reputation,
          // G6: full raw generated identity (first/last/username/email/password/
          // DOB) for EVERY run that has one — not just register. Raw values in
          // the row are explicitly approved. Present whenever a platform was
          // given (ws.identity is generated then); session_meta.json doubles as
          // the storage backup for non-register runs that never call saveAccount.
          identity: ws.identity,
          // G9: per-run human-timing seed (required non-null) — makes this run's
          // mouse/typing jitter reproducible from the row.
          timing_seed: timingSeed,
          started_at: new Date().toISOString(),
        };
        // G12: write provenance into the worker's ACTION dir (set by poll.ts on
        // every spawned trajectory) so it lands where poll.ts imports + uploads
        // from — even when this WSession's label differs from the dispatch action
        // (health _in/_out, register _<attempt>, reddit submit, ticker scrapers).
        // Falls back to label for standalone (non-worker) runs.
        writeFileSync(join(recordingsDir(process.env.ACTION || label), 'session_meta.json'), JSON.stringify(meta, null, 2));
      } catch {}
    }
    // Complete-record network capture: NO domain filter, NO body truncation.
    // Captures every request/response (utf8 + base64), WebSocket frames in both
    // directions, TCP serverAddr, TLS securityDetails. Runs on every WSession —
    // keepers and trajectories — without exception. See net_record.ts.
    if (process.env.WELES_NO_INSTRUMENT !== '1') startInstrumentation(ws, ctx, label);
    return ws;
  }

  async goto(url: string): Promise<string> {
    return this.runStep(`goto_${url.split('/').pop()?.slice(0,20)}`, async () => {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitCloudflare(asV(this.page)).catch(() => {});
      return `navigated to ${this.page.url?.() ?? url}`;
    });
  }

  // Method bodies extracted to ./wsession-helpers/finalize.ts to fit the
  // 300-line per-file cap. wsClose has the BD provider classifier fix.
  async click(target: string): Promise<string> { const { wsClick } = await import('./wsession-helpers/finalize.js'); return wsClick(this, target); }
  async fill(target: string, value: string): Promise<string> { const { wsFill } = await import('./wsession-helpers/finalize.js'); return wsFill(this, target, value); }

  async focus(selector: string): Promise<string> {
    return this.runStep(`focus_${selector}`, async () => {
      const simple = selector.split(' ').pop()?.toLowerCase().replace(/['"[\]]/g, '') ?? '';
      const sels = [selector, `input[name="${selector}"]`, `input[type="${selector}"]`, `input[placeholder*="${selector}" i]`];
      if (simple && simple !== selector) sels.push(`input[name="${simple}"]`, `input[placeholder*="${simple}" i]`);
      for (const s of sels) { try { const b = await this.page.locator?.(s)?.first?.()?.boundingBox?.(); if (b) { await humanClick(this.page, b.x + b.width / 2, b.y + b.height / 2); return `focused: ${s}`; } } catch {} }
      return 'no-element-found';
    });
  }

  async jsClick(selector?: string, text?: string): Promise<string> {
    return this.runStep(`jsClick_${text ?? selector}`, async () => {
      const sel = JSON.stringify(selector ?? ''), txt = JSON.stringify((text ?? '').toLowerCase());
      const sr = await this.page.evaluate(`(()=>{var t=${txt};function F(r){var a=[];r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot){var sr=e.shadowRoot;a=a.concat(Array.from(sr.querySelectorAll('[data-post-click-location] button')));a=a.concat(F(sr))}});return a}var bs=F(document);if(t&&t.indexOf('upvote')>=0&&bs.length>0){bs[0].click();return'clicked upvote (shadow)'}if(t&&t.indexOf('downvote')>=0&&bs.length>1){bs[1].click();return'clicked downvote (shadow)'}return null})()`).catch(() => null);
      if (sr) return sr;
      if (selector) { try { const loc = this.page.locator(selector).first(); if (await loc.count()) { await loc.click(); return `clicked: ${selector.slice(0, 60)}`; } } catch { /* try eval */ } }
      if (text) { try { const loc = this.page.getByRole('button', { name: new RegExp(text, 'i') }).first(); if (await loc.count()) { await loc.click(); return `clicked text: ${text.slice(0, 60)}`; } } catch { /* try eval */ } }
      const r = await this.page.evaluate(`(()=>{function F(r,s){var a=Array.from(r.querySelectorAll(s));r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot)a=a.concat(F(e.shadowRoot,s))});return a}var s=${sel},t=${txt};if(s){try{var e=F(document,s)[0];if(e){e.click();return'clicked-untrusted: '+s}}catch(e){}}if(t){var els=F(document,'button,a,[role="button"],[class*="vote"],[class*="like"],[class*="star"],[class*="follow"]');for(var i=0;i<els.length;i++){var x=((els[i].textContent||'')+(els[i].getAttribute('aria-label')||'')).toLowerCase();if(x.indexOf(t)>=0){els[i].click();return'clicked-untrusted: '+(els[i].getAttribute('aria-label')||els[i].textContent||'').trim().slice(0,40)}}}return null})()`).catch(() => null);
      return r ?? 'no-element-found';
    });
  }

  async clickSelector(selector: string): Promise<string> { return this.runStep(`clickSel_${selector.slice(0,30)}`, async () => { const loc = this.page.locator(selector).first(); if (!(await loc.count())) return 'no-element-found'; const { humanClickLocator } = await import('../human/mouse.js'); await humanClickLocator(this.page, loc); return `clicked ${selector.slice(0,60)}`; }); }
  async type(value: string): Promise<string> { return this.runStep('type', async () => { await humanType(this.page, this.resolveEnv(value)); return 'typed'; }); }
  async press(key: string): Promise<string> { return this.runStep(`press_${key}`, async () => { await this.page.keyboard.press(key); return `pressed ${key}`; }); }
  async select(target: string, value: string): Promise<string> { return this.runStep(`select_${target}_${value}`, async () => { const result = await selectOption(this.page, target, this.resolveEnv(value)); return result ? `selected: ${result}` : 'no-select-found'; }); }

  async scroll(direction: string, amount?: number): Promise<string> {
    return this.runStep(`scroll_${direction}`, async () => {
      const delta = (direction === 'up' ? -(amount ?? 400) : (amount ?? 400));
      await this.page.evaluate(`window.scrollBy(0, ${delta})`);
      return `scrolled ${direction} ${amount ?? 400}`;
    });
  }

  async wait(seconds: number): Promise<string> { await new Promise(r => setTimeout(r, seconds * 1000)); return `waited ${seconds}s`; }  // allow-raw-playwright: review — context-dependent timer
  async read(question: string): Promise<string> { return await askPage(asV(this.page), question) ?? 'NONE'; }
  async solveCaptcha(): Promise<string> { return this.runStep('solveCaptcha', async () => (await solvePageCaptcha(this.page, this._solver, this)) ? 'captcha solved' : 'captcha failed'); }

  async checkEmail(email: string, sender: string): Promise<string> { const { wsCheckEmail } = await import('./wsession-helpers/finalize.js'); return wsCheckEmail(this, email, sender); }
  async checkSms(service: string, country = 'UK'): Promise<string> { this._smsOrder = await getNumber(service, country); if (!this._smsOrder) return 'error: no SMS number available'; this._env[`${service.toUpperCase()}_NEW_PHONE`] = this._smsOrder.phone; return `phone: ${this._smsOrder.phone}`; }
  async pollSmsCode(): Promise<string> { if (!this._smsOrder) return 'error: no SMS order'; return (await pollCode(this._smsOrder.orderId, this._smsOrder.provider)) ?? 'no code received'; }

  async generateIdentity(platform: string): Promise<Identity> {
    const id = await genId(platform);
    const k = platform.toUpperCase();
    this._env[`${k}_NEW_USERNAME`] = id.username;
    this._env[`${k}_NEW_EMAIL`] = id.email;
    this._env[`${k}_NEW_PASSWORD`] = id.password;
    this._env[`${k}_NEW_FIRSTNAME`] = id.firstName;
    this._env[`${k}_NEW_LASTNAME`] = id.lastName;
    this._env[`${k}_NEW_BIRTHMONTH`] = id.birthMonth;
    this._env[`${k}_NEW_BIRTHDAY`] = id.birthDay;
    this._env[`${k}_NEW_BIRTHYEAR`] = id.birthYear;
    return id;
  }

  async saveCookies(): Promise<string> { if (!this.label) return 'no label'; await this._store.capturePlaywright(this.ctx, this.label); return 'cookies saved'; }
  async needsLogin(): Promise<boolean> { return await checkPage(asV(this.page), 'Is this a login page?'); }
  async screenshot(label: string): Promise<string> { return await this._cap.screenshot(this.page, label); }

  async saveAccount(platform: string, data: { username: string; email: string; password: string; name?: string; status?: string }): Promise<string> { const { wsSaveAccount } = await import('./wsession-helpers/finalize.js'); return wsSaveAccount(this, platform, data); }
  async close(): Promise<void> { const { wsClose } = await import('./wsession-helpers/finalize.js'); return wsClose(this); }

  resolveEnv(v: string): string { return v.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_, k) => this._env[k] ?? process.env[k] ?? v); }

  /** Derive a stable proxy signature for cookie-jar binding (mirrors cookie-freshness.mjs). */
  private _proxySignature(): string | null {
    const cfg = this.proxyConfig;
    if (!cfg) return null;
    if (typeof cfg === 'object' && (cfg as any).host) {
      const port = (cfg as any).port ? String((cfg as any).port) : '';
      return `${(cfg as any).host}:${port}`.replace(/:$/, '');
    }
    if (typeof cfg === 'string') {
      try { const u = new URL(cfg); return `${u.hostname}:${u.port || ''}`.replace(/:$/, ''); } catch { return null; }
    }
    return null;
  }

  /** Derive a stable persona signature for cookie-jar binding (mirrors cookie-freshness.mjs). */
  private _personaSignature(): string | null {
    const p = this.personaConfig as any;
    if (!p) return null;
    if (p.canvasSeed != null) return `cs:${p.canvasSeed}`;
    const s = `${p.userAgentOs ?? ''}|${p.gpu?.renderer ?? ''}|${p.timezone ?? ''}|${p.language ?? ''}`;
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return `h:${h}`;
  }
}

function profileUrl(platform: string, username: string, name?: string): string {
  const urls: Record<string, string> = { reddit: `https://reddit.com/u/${username}`, tiktok: `https://tiktok.com/@${username}`, github: `https://github.com/${username}`, discord: `https://discord.com/users/${username}`, linkedin: `https://linkedin.com/in/${(name ?? username).toLowerCase().replace(/\s+/g, '-')}`, instagram: `https://instagram.com/${username}`, twitter: `https://x.com/${username}` };
  return urls[platform] ?? '';
}

installAtoms(WSession);
