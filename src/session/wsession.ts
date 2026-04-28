/**
 * WSession — unified high-level API for weles browser automation.
 * Every method uses shared modules. Agent tools map 1:1 to these methods.
 */

import { type BrowserContext, chromium } from 'playwright'; import { AsyncNewBrowser, type AsyncNewBrowserOptions } from '../async_api.js';
import { type Persona, generatePersona } from '../browser/persona.js';
import { SessionStore } from './store.js';
import { Capture } from '../capture/capture.js';
import { findClickTarget, askPage, checkPage, type ScreenshottablePage } from '../vision/analyze.js';
import { humanClick } from '../human/mouse.js';
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

import { installAtoms } from './wsession_atoms.js';  // installAtoms() is invoked at file end after WSession is declared
function recordingsDir(label?: string): string { const d = join(process.cwd(), 'recordings', ...(label ? [label] : [])); mkdirSync(d, { recursive: true }); return d; }

export interface WSessionOptions {
  label?: string;
  proxy?: string;
  chromiumPath?: string;
  headless?: boolean;
  record?: boolean;
  cdpEndpoint?: string;
  os?: string;
  locale?: string;
  persona?: Persona;
  browser?: string;
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
  capturedResponses: Array<{ ts: number; method: string; url: string; status: number; headers: Record<string, string>; body: string }> = [];
  private _smsOrder: SmsNumber | null = null;

  private constructor(ctx: BrowserContext, page: any, label: string, cap: Capture) {
    this.ctx = ctx; this.page = page; this.label = label; this._cap = cap;
    this._store = new SessionStore(); this._solver = new CaptchaSolver();
    // Intercept API responses to capture captcha data (Discord register + login)
    const authPaths = ['/auth/register', '/auth/login'];
    page.on?.('request', (req: any) => { try { const u = req.url(); if (authPaths.some(p => u.includes(p)) && req.method() === 'POST') { this.captchaFormData = JSON.parse(req.postData() ?? '{}'); this.captchaEndpoint = u; const h = req.headers(); this.captchaHeaders = {}; for (const k of Object.keys(h)) { if (k.startsWith('x-')) this.captchaHeaders[k] = h[k]; } } } catch {} });
    page.on?.('response', async (res: any) => { try { const u = res.url(); if (authPaths.some(p => u.includes(p)) && res.status() >= 400) { const d = await res.json(); if (d.captcha_key !== undefined) { this.captchaResponse = d; console.log(`[wsession] Captured captcha data: sitekey=${d.captcha_sitekey?.slice(0, 12)}`); } const errs = d?.errors?.login?._errors ?? d?.errors?.email?._errors ?? []; const code = errs[0]?.code; if (code === 'ACCOUNT_PERMANENTLY_DISABLED' || code === 'ACCOUNT_DISABLED' || code === 'ACCOUNT_LOGIN_BLOCKED') { this.authBlocked = code; console.log(`[wsession] Auth blocked by platform: ${code}`); } } } catch {} });
    ctx.on?.('response', async (res: any) => { try { if (this.capturedResponses.length >= 500) this.capturedResponses.shift(); let body = ''; try { body = (await res.text()).slice(0, 8192); } catch {} this.capturedResponses.push({ ts: Date.now(), method: res.request()?.method?.() ?? 'GET', url: res.url(), status: res.status(), headers: res.headers(), body }); } catch {} });
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
    console.log(`[wsession] start() label=${label} cdp=${!!cdp} proxy=${opts.proxy}`);
    if (cdp) {
      const browser = await chromium.connectOverCDP(cdp);
      const ctx = browser.contexts()[0] || await browser.newContext({ locale: 'en-US' }); const page = ctx.pages()[0] || await ctx.newPage();
      return new WSession(ctx, page, label, new Capture({ newPage: async () => page } as any, label ? recordingsDir(label) : undefined));
    }
    const proxy = opts.proxy ? await resolveProxy(opts.proxy, (opts as any).targetHost) : undefined;
    const persona: Persona = opts.persona ?? generatePersona({ country: proxy?.country, os: opts.os as Persona['os'] | undefined, browser: opts.browser as Persona['browser'] | undefined });
    const bOpts: AsyncNewBrowserOptions = { os: persona.os, browser: persona.browser, headless: opts.headless ?? false, recordVideo: opts.record ?? (process.env.WELES_DISABLE_RECORDING !== '1'), locale: opts.locale, persona, proxy };
    const cp = opts.chromiumPath ?? process.env.CHROMIUM_PATH ?? findCustomBrowser(bOpts.browser);
    if (bOpts.browser === 'chromium' && !cp) throw new Error('Custom Chromium not found. Set CHROMIUM_PATH or install to a known location.');
    if (cp && bOpts.browser === 'chromium') bOpts.chromiumPath = cp;
    const ctx = await AsyncNewBrowser(bOpts);
    const page = ctx.pages()[0] || await ctx.newPage();
    const cap = new Capture({ newPage: async () => page } as any, label ? recordingsDir(label) : undefined);
    if (label) { const s = new SessionStore(); await s.injectPlaywright(ctx, label).catch(() => {}); }
    const ws = new WSession(ctx, page, label, cap); ws.proxyConfig = bOpts.proxy; ws.personaConfig = persona; if (label && bOpts.proxy?.server) { try { const u = new URL(bOpts.proxy.server); writeFileSync(join(recordingsDir(label), 'session_meta.json'), JSON.stringify({ proxy_host: u.hostname, proxy_port: u.port, proxy_user: bOpts.proxy.username?.slice(0, 80), proxy_full: bOpts.proxy.server, exit_ip: bOpts.proxy.exit_ip, platform: bOpts.proxy.platform, started_at: new Date().toISOString() }, null, 2)); } catch {} }
    if (process.env.WELES_INSTRUMENT === '1') { const dir = join(process.cwd(), '.work', 'inst'); mkdirSync(dir, { recursive: true }); const ts = new Date().toISOString().replace(/[:.]/g, '-'); const fn = join(dir, `${label || 'session'}_${ts}.json`); const accum = new Map(); const reqs: any[] = []; const netFilter = /github\.com|arkoselabs\.com|octocaptcha\.com/; ctx.on('request', (req) => { try { const u = req.url(); if (!netFilter.test(u)) return; let post = ''; try { post = req.postData()?.slice(0, 4000) || ''; } catch {} reqs.push({ t: Date.now(), phase: 'req', method: req.method(), url: u, headers: req.headers(), postData: post }); } catch {} }); ctx.on('response', async (resp) => { try { const u = resp.url(); if (!netFilter.test(u)) return; let body = ''; try { body = (await resp.text()).slice(0, 8000); } catch {} reqs.push({ t: Date.now(), phase: 'res', status: resp.status(), url: u, headers: resp.headers(), body }); } catch {} }); setInterval(async () => { try { for (const f of ws.page.frames()) { try { const j: string = await f.evaluate('(window.__inst_flush)?window.__inst_flush():"[]"'); const log = JSON.parse(j); if (!log.length) continue; const url = f.url(); const prev = accum.get(url); if (!prev || log.length > prev.log.length) accum.set(url, { url, log }); } catch {} } writeFileSync(fn, JSON.stringify({ accesses: [...accum.values()], requests: reqs })); } catch {} }, 5000); }
    return ws;
  }

  async goto(url: string): Promise<string> {
    return this.runStep(`goto_${url.split('/').pop()?.slice(0,20)}`, async () => {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitCloudflare(asV(this.page)).catch(() => {});
      return `navigated to ${this.page.url?.() ?? url}`;
    });
  }

  async click(target: string): Promise<string> {
    return this.runStep(`click_${target}`, async () => {
      const coords = await findClickTarget(asV(this.page), target);
      if (coords) { await humanClick(this.page, coords.x, coords.y); return `clicked ${target}`; }
      // Two-pass DOM text match: exact-first (trimmed), then substring. Substring
      // alone matches "Sign in with Apple" before "Sign in" — broke linkedin_login.
      const c = await this.page.evaluate(`(()=>{function F(r,s){var a=Array.from(r.querySelectorAll(s));r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot)a=a.concat(F(e.shadowRoot,s))});return a}function vis(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0&&el.offsetParent!==null}var t=${JSON.stringify(target.toLowerCase().trim())};var sr=F(document,'[data-post-click-location] button');if(t.indexOf('upvote')>=0&&sr.length>0){var r=sr[0].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,desc:'upvote (shadow)'}}var bs=F(document,'button,a,[role="button"],label,input[type="checkbox"],[role="checkbox"]');var exact=null,partial=null;for(var i=0;i<bs.length;i++){var el=bs[i];var txt=((el.textContent||'').trim()+' '+(el.getAttribute('aria-label')||'').trim()).toLowerCase().trim();var visi=vis(el);if(!visi)continue;if(txt===t||txt.split(' ').join(' ')===t){exact=el;break}if(!partial&&txt.indexOf(t)>=0){partial=el}}var hit=exact||partial;if(!hit)return null;var cb=hit.querySelector('input[type="checkbox"]')||hit;var r=cb.getBoundingClientRect();if(r.width<1){r=hit.getBoundingClientRect()}var d=((hit.textContent||'').trim()||(hit.getAttribute('aria-label')||'')).slice(0,40);return{x:r.x+r.width/2,y:r.y+r.height/2,desc:(exact?'exact:':'partial:')+d}})()`).catch(() => null);
      if (c) { await humanClick(this.page, c.x, c.y); return `clicked ${c.desc ?? target}`; }
      return 'no-target-found';
    });
  }

  async fill(target: string, value: string): Promise<string> {
    return this.runStep(`fill_${target}`, async () => {
    const v = this.resolveEnv(value);
    // Playwright's accessible-label resolver finds <label>Username or email</label>
    // bound inputs even when the input's own name/placeholder/aria-label don't match
    // the target keywords (e.g. github's <input name="login">). Try this first.
    try { const lbl = this.page.getByLabel?.(target, { exact: false })?.first?.(); if (lbl && await lbl.isVisible({ timeout: 1500 }).catch(() => false)) { await lbl.fill(v); return 'filled'; } } catch {}
    const kws = target.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
    const sels = kws.flatMap(k => ['input','textarea','[contenteditable]'].flatMap(t => [`${t}[name*="${k}"]`,`${t}[placeholder*="${k}" i]`,`${t}[aria-label*="${k}" i]`]));
    for (const sel of sels) { try { const el = this.page.locator?.(sel)?.first?.(); if (el && await el.isVisible()) { await el.fill(v); return 'filled'; } } catch {} }
    const tgt = JSON.stringify(target.toLowerCase());
    const c = await this.page.evaluate(`(()=>{var t=${tgt};for(var el of document.querySelectorAll('*')){var r=el.getBoundingClientRect();var ph=(el.getAttribute('placeholder')||'').toLowerCase();if(r.width>50&&r.height>10&&r.x>0&&ph&&ph.indexOf(t)>=0)return{x:r.x+r.width/2,y:r.y+r.height/2}}return null})()`).catch(() => null);
    if (c) { await humanClick(this.page, c.x, c.y); await this.page.keyboard.press('Meta+a').catch(() => {}); await humanType(this.page, v); return 'filled'; }
    const vc = await findClickTarget(asV(this.page), target);
    if (vc) { await humanClick(this.page, vc.x, vc.y); await this.page.keyboard.press('Meta+a').catch(() => {}); await humanType(this.page, v); return 'filled'; }
    return 'no-field-found';
    });
  }

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
      // Shadow DOM deep search — el.click() in evaluate produces isTrusted=false; KEPT for Reddit (only-locator-inaccessible surface; Reddit is permissive about isTrusted).
      const sr = await this.page.evaluate(`(()=>{var t=${txt};function F(r){var a=[];r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot){var sr=e.shadowRoot;a=a.concat(Array.from(sr.querySelectorAll('[data-post-click-location] button')));a=a.concat(F(sr))}});return a}var bs=F(document);if(t&&t.indexOf('upvote')>=0&&bs.length>0){bs[0].click();return'clicked upvote (shadow)'}if(t&&t.indexOf('downvote')>=0&&bs.length>1){bs[1].click();return'clicked downvote (shadow)'}return null})()`).catch(() => null);
      if (sr) return sr;
      // Prefer locator.click() so isTrusted=true (per ce369f6 — TikTok/LinkedIn/Arkose reject isTrusted=false). Fall through to evaluate only when locator finds nothing.
      if (selector) { try { const loc = this.page.locator(selector).first(); if (await loc.count()) { await loc.click(); return `clicked: ${selector.slice(0, 60)}`; } } catch { /* try eval */ } }
      if (text) { try { const loc = this.page.getByRole('button', { name: new RegExp(text, 'i') }).first(); if (await loc.count()) { await loc.click(); return `clicked text: ${text.slice(0, 60)}`; } } catch { /* try eval */ } }
      const r = await this.page.evaluate(`(()=>{function F(r,s){var a=Array.from(r.querySelectorAll(s));r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot)a=a.concat(F(e.shadowRoot,s))});return a}var s=${sel},t=${txt};if(s){try{var e=F(document,s)[0];if(e){e.click();return'clicked-untrusted: '+s}}catch(e){}}if(t){var els=F(document,'button,a,[role="button"],[class*="vote"],[class*="like"],[class*="star"],[class*="follow"]');for(var i=0;i<els.length;i++){var x=((els[i].textContent||'')+(els[i].getAttribute('aria-label')||'')).toLowerCase();if(x.indexOf(t)>=0){els[i].click();return'clicked-untrusted: '+(els[i].getAttribute('aria-label')||els[i].textContent||'').trim().slice(0,40)}}}return null})()`).catch(() => null);
      return r ?? 'no-element-found';
    });
  }

  async clickSelector(selector: string): Promise<string> { return this.runStep(`clickSel_${selector.slice(0,30)}`, async () => { const loc = this.page.locator(selector).first(); if (!(await loc.count())) return 'no-element-found'; await loc.click(); return `clicked ${selector.slice(0,60)}`; }); }
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

  async wait(seconds: number): Promise<string> { await new Promise(r => setTimeout(r, seconds * 1000)); return `waited ${seconds}s`; }
  async read(question: string): Promise<string> { return await askPage(asV(this.page), question) ?? 'NONE'; }
  async solveCaptcha(): Promise<string> { return this.runStep('solveCaptcha', async () => (await solvePageCaptcha(this.page, this._solver, this)) ? 'captcha solved' : 'captcha failed'); }

  async checkEmail(email: string, sender: string): Promise<string> {
    const key = await getEmailApiKey() ?? '';
    if (!key) return 'error: no RESEND_RECEIVING_API_KEY';
    const addr = this.resolveEnv(email).toLowerCase();
    // Only accept codes from emails received AFTER this trajectory started,
    // minus a small grace window for clock skew + in-flight emails. Stale
    // codes from a previous login attempt were being returned, Instagram
    // rejecting them as expired; this scopes to "this run's" inbox.
    const earliestAcceptMs = Date.now() - 90_000;
    for (let i = 0; i < 30; i++) {
      const r = await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${key}` } });
      for (const em of ((await r.json()) as any).data ?? []) {
        const to = (em.to ?? []).map((t: any) => (typeof t === 'string' ? t : t.email ?? '').toLowerCase());
        if (!to.includes(addr)) continue;
        if (sender && !(em.from ?? '').toLowerCase().includes(sender)) continue;
        const emAt = em.created_at ? new Date(em.created_at).getTime() : 0;
        if (emAt < earliestAcceptMs) continue;
        const d = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${key}` } })).json() as any;
        const codes = `${d.subject ?? ''} ${d.text ?? ''} ${d.html ?? ''}`.match(/\b\d{5,6}\b/g);
        if (codes) return codes[0];
      }
      await new Promise(r => setTimeout(r, 10000));
    }
    return 'no code received';
  }

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

  /** Save created account to Supabase social_accounts table. */
  async saveAccount(platform: string, data: { username: string; email: string; password: string; name?: string; status?: string }): Promise<string> {
    const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '';
    if (!url || !key) return 'error: no SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY';
    const username = this.resolveEnv(data.username);
    const email = this.resolveEnv(data.email);
    const password = this.resolveEnv(data.password);
    const name = data.name ? this.resolveEnv(data.name) : undefined;
    const cookies = await this.ctx.cookies().catch(() => []);
    const row = {
      platform,
      username,
      display_name: name,
      profile_url: profileUrl(platform, username, name),
      metadata: { email, password, status: data.status ?? 'created', created_via: 'weles', cookies, cookies_updated_at: new Date().toISOString(), proxy: this.proxyConfig ?? null, persona: this.personaConfig ?? null },
      is_active: true,
      created_by: 'weles',
    };
    const res = await fetch(`${url}/rest/v1/social_accounts`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!res.ok) return `error: ${res.status} ${await res.text().catch(() => '')}`;
    try { const r = await res.json(); writeFileSync(join(recordingsDir(this.label || undefined), 'account.json'), JSON.stringify(Array.isArray(r)?r[0]:r, null, 2)); } catch {} await markSignupSuccess(email).catch(() => {}); return `account saved: ${platform}/${username}`;
  }

  async close(): Promise<void> {
    console.log(`[wsession] close() label=${this.label}`);
    await this._cap.save('session', this.page).catch(() => {}); try { writeFileSync(join(recordingsDir(this.label || undefined), 'network.ndjson'), this.capturedResponses.map(r => JSON.stringify(r)).join('\n')); } catch {}
    if (process.env.WELES_INSTRUMENT === '1' && !this.page.isClosed?.()) { try { const j: string = await this.page.evaluate('(window.__inst_flush)?window.__inst_flush():"[]"'); const outDir = join(process.cwd(), '.work', 'inst'); mkdirSync(outDir, { recursive: true }); const fn = join(outDir, `${this.label || 'session'}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`); writeFileSync(fn, j); console.log(`[wsession] dumped __inst ${j.length}ch -> ${fn}`); } catch (e: any) { console.log(`[wsession] __inst dump err: ${e.message?.slice(0,120)}`); } }
    const video = this.page.video?.();
    const dest = join(recordingsDir(this.label || undefined), `${this.label || 'session'}_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);
    console.log(`[wsession] close() video=${!!video} dest=${dest}`);
    await this.page.close().catch((e: any) => console.log(`[wsession] page.close error: ${e.message?.slice(0, 200)}`));
    if (video) { await video.saveAs(dest).catch((e: any) => { console.log(`[wsession] video.saveAs error: ${e.message?.slice(0, 200)}`); try { const src = video.path?.() as string | undefined; if (src) { copyFileSync(src, dest); console.log(`[wsession] video copied from ${src}`); } } catch {} }); }
    await this.ctx.close().catch((e: any) => console.log(`[wsession] ctx.close error: ${e.message?.slice(0, 200)}`));
    console.log(`[wsession] close() done`);
  }

  resolveEnv(v: string): string { return v.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_, k) => this._env[k] ?? process.env[k] ?? v); }
}

function profileUrl(platform: string, username: string, name?: string): string {
  const urls: Record<string, string> = { reddit: `https://reddit.com/u/${username}`, tiktok: `https://tiktok.com/@${username}`, github: `https://github.com/${username}`, discord: `https://discord.com/users/${username}`, linkedin: `https://linkedin.com/in/${(name ?? username).toLowerCase().replace(/\s+/g, '-')}`, instagram: `https://instagram.com/${username}`, twitter: `https://x.com/${username}` };
  return urls[platform] ?? '';
}

installAtoms(WSession);
