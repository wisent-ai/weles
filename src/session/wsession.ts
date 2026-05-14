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
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProxy } from '../proxy/config.js';
import { getEmailApiKey } from '../utils/credentials.js';
import { findCustomBrowser } from './find_browser.js';
import { costTracker } from '../utils/cost.js';

import { installAtoms } from './wsession_atoms.js';  // installAtoms() is invoked at file end after WSession is declared
function recordingsDir(label?: string): string { const d = join(process.cwd(), 'recordings', ...(label ? [label] : [])); mkdirSync(d, { recursive: true }); return d; }

export interface WSessionOptions {
  label?: string;
  proxy?: string;
  chromiumPath?: string;
  headless?: boolean;
  record?: boolean;
  cdpEndpoint?: string;
  targetHost?: string;
  os?: string;
  locale?: string;
  persona?: Persona;
  browser?: string;
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
    ctx.on?.('response', async (res: any) => { try { if (this.capturedResponses.length >= 500) this.capturedResponses.shift(); let body = ''; try { body = (await res.text()).slice(0, 8192); } catch {} this.capturedResponses.push({ ts: Date.now(), method: res.request()?.method?.() ?? 'GET', url: res.url(), status: res.status(), headers: res.headers(), body }); } catch {} });
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
    const cdp = opts.cdpEndpoint ?? process.env.BRIGHTDATA_BROWSER_WS;
    console.log(`[wsession] start() label=${label} cdp=${!!cdp} proxy=${redactProxyForLog(opts.proxy)}`);
    if (cdp) {
      const browser = await chromium.connectOverCDP(cdp);
      const ctx = browser.contexts()[0] || await browser.newContext({ locale: 'en-US' }); const page = ctx.pages()[0] || await ctx.newPage();
      return new WSession(ctx, page, label, new Capture({ newPage: async () => page } as any, label ? recordingsDir(label) : undefined));
    }
    const proxyRequested = !!opts.proxy && !['none', 'direct'].includes(String(opts.proxy).toLowerCase());
    const proxy = proxyRequested ? await resolveProxy(opts.proxy!, opts.targetHost) : undefined;
    if (proxyRequested && !proxy) {
      throw new Error(`proxy_unavailable: requested ${opts.proxy} for ${opts.targetHost ?? 'unknown target'}`);
    }
    const persona: Persona = opts.persona ?? generatePersona({ country: proxy?.country, os: opts.os as Persona['os'] | undefined, browser: opts.browser as Persona['browser'] | undefined });
    const bOpts: AsyncNewBrowserOptions = { os: persona.os, browser: persona.browser, headless: opts.headless ?? false, recordVideo: opts.record ?? (process.env.WELES_DISABLE_RECORDING !== '1'), locale: opts.locale, persona, proxy };
    const cp = opts.chromiumPath ?? process.env.CHROMIUM_PATH ?? findCustomBrowser(bOpts.browser);
    if (bOpts.browser === 'chromium' && !cp) throw new Error('Custom Chromium not found. Set CHROMIUM_PATH or install to a known location.');
    if (cp && bOpts.browser === 'chromium') bOpts.chromiumPath = cp;
    const ctx = await AsyncNewBrowser(bOpts);
    const page = ctx.pages()[0] || await ctx.newPage();
    const cap = new Capture({ newPage: async () => page } as any, label ? recordingsDir(label) : undefined);
    if (label) { const s = new SessionStore(); await s.injectPlaywright(ctx, label).catch(() => {}); }
    const ws = new WSession(ctx, page, label, cap); ws.proxyConfig = bOpts.proxy; ws.personaConfig = persona;
    if (opts.platform) { ws.identity = await genId(opts.platform); console.log(`[wsession] identity ${ws.identity.email} (${ws.identity.firstName} ${ws.identity.lastName})`); }
    if (label && bOpts.proxy?.server) { try { const u = new URL(bOpts.proxy.server); writeFileSync(join(recordingsDir(label), 'session_meta.json'), JSON.stringify({ proxy_host: u.hostname, proxy_port: u.port, proxy_user: bOpts.proxy.username?.slice(0, 80), proxy_full: bOpts.proxy.server, exit_ip: bOpts.proxy.exit_ip, platform: bOpts.proxy.platform, provider: (bOpts.proxy as any).provider, started_at: new Date().toISOString() }, null, 2)); } catch {} }
    if (process.env.WELES_INSTRUMENT === '1') { const dir = join(process.cwd(), '.work', 'inst'); mkdirSync(dir, { recursive: true }); const ts = new Date().toISOString().replace(/[:.]/g, '-'); const fn = join(dir, `${label || 'session'}_${ts}.json`); const accum = new Map(); const reqs: any[] = []; const netFilter = /github\.com|arkoselabs\.com|octocaptcha\.com|linkedin\.com|protechts\.net|perimeterx\.net/; ctx.on('request', (req) => { try { const u = req.url(); if (!netFilter.test(u)) return; let post = ''; try { post = req.postData()?.slice(0, 4000) || ''; } catch {} reqs.push({ t: Date.now(), phase: 'req', method: req.method(), url: u, headers: req.headers(), postData: post }); } catch {} }); ctx.on('response', async (resp) => { try { const u = resp.url(); if (!netFilter.test(u)) return; let body = ''; try { body = (await resp.text()).slice(0, 8000); } catch {} reqs.push({ t: Date.now(), phase: 'res', status: resp.status(), url: u, headers: resp.headers(), body }); } catch {} }); setInterval(async () => { try { for (const f of ws.page.frames()) { try { const j: string = await f.evaluate('(window.__inst_flush)?window.__inst_flush():"[]"'); const log = JSON.parse(j); if (!log.length) continue; const url = f.url(); const prev = accum.get(url); if (!prev || log.length > prev.log.length) accum.set(url, { url, log }); } catch {} } writeFileSync(fn, JSON.stringify({ accesses: [...accum.values()], requests: reqs })); } catch {} }, 5000); }
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
