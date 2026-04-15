/**
 * WSession — unified high-level API for weles browser automation.
 * Every method uses shared modules. Agent tools map 1:1 to these methods.
 */

import { type BrowserContext } from 'playwright';
import { AsyncNewBrowser, type AsyncNewBrowserOptions } from '../async_api.js';
import { SessionStore } from './store.js';
import { Capture } from '../capture/capture.js';
import { findClickTarget, askPage, checkPage, type ScreenshottablePage } from '../vision/analyze.js';
import { humanClick } from '../human/mouse.js';
import { waitCloudflare } from '../cloudflare/challenge.js';
import { solvePageCaptcha } from '../captcha/detect.js';
import { CaptchaSolver } from '../captcha/solver.js';
import { generateIdentity as genId, type Identity } from '../utils/identity.js';
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function recordingsDir(): string { const d = join(process.cwd(), 'recordings'); mkdirSync(d, { recursive: true }); return d; }

function findCustomChromium(): string | undefined {
  const candidates = [
    join(process.env.HOME ?? '', 'Documents/CodingProjects/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium'),
    '/opt/chromium/Chromium',
  ];
  for (const p of candidates) { if (existsSync(p)) return p; }
  return undefined;
}

export interface WSessionOptions {
  label?: string;
  proxy?: string;
  chromiumPath?: string;
  headless?: boolean;
  record?: boolean;
}

const asV = (p: any) => p as unknown as ScreenshottablePage;

function resolveProxy(proxy: string): { server: string; username?: string; password?: string } | undefined {
  if (!proxy || proxy === 'none' || proxy === 'direct') return undefined;
  const shortcuts: Record<string, string> = {
    residential: `http://${process.env.PINGPROXIES_USERNAME}_c_US:${process.env.PINGPROXIES_PASSWORD}@residential.pingproxies.com:8000`,
    datacenter: `http://${process.env.PACKETSTREAM_USERNAME}:${process.env.PACKETSTREAM_PASSWORD}@proxy.packetstream.io:31112`,
    mobile: `http://${process.env.OXYLABS_MOBILE_USERNAME}:${process.env.OXYLABS_MOBILE_PASSWORD}@us-pr.oxylabs.io:30000`,
  };
  const url = shortcuts[proxy] ?? proxy;
  const u = new URL(url);
  return { server: `${u.protocol}//${u.hostname}:${u.port}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

export class WSession {
  readonly page: any;
  readonly ctx: BrowserContext;
  readonly label: string;
  private _cap: Capture;
  private _store: SessionStore;
  private _solver: CaptchaSolver;
  private _env: Record<string, string> = {};

  private _step = 0;
  private constructor(ctx: BrowserContext, page: any, label: string, cap: Capture) {
    this.ctx = ctx; this.page = page; this.label = label; this._cap = cap;
    this._store = new SessionStore(); this._solver = new CaptchaSolver();
  }

  private async _action<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const n = String(this._step++).padStart(3, '0');
    const label = `${n}_${name.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}`;
    await this._cap.screenshot(this.page, `before_${label}`).catch(() => {});
    await this._saveDom(`before_${label}`);
    try {
      const result = await fn();
      await this._cap.screenshot(this.page, `after_${label}`).catch(() => {});
      await this._saveDom(`after_${label}`);
      return result;
    } catch (e) {
      await this._cap.screenshot(this.page, `error_${label}`).catch(() => {});
      await this._saveDom(`error_${label}`);
      throw e;
    }
  }

  private async _saveDom(label: string): Promise<void> {
    const html = await this.page.content?.().catch(() => null);
    if (html) writeFileSync(join(recordingsDir(), `${label}_dom.html`), html);
  }

  static async start(opts: WSessionOptions = {}): Promise<WSession> {
    const label = opts.label ?? '';
    const bOpts: AsyncNewBrowserOptions = { os: 'macos', browser: 'chromium', headless: opts.headless ?? false, recordVideo: opts.record ?? true };
    const chromiumPath = opts.chromiumPath ?? process.env.CHROMIUM_PATH ?? findCustomChromium();
    if (!chromiumPath) throw new Error('Custom Chromium not found. Set CHROMIUM_PATH or install to a known location.');
    bOpts.chromiumPath = chromiumPath;
    if (opts.proxy) bOpts.proxy = resolveProxy(opts.proxy);
    const ctx = await AsyncNewBrowser(bOpts);
    const page = ctx.pages()[0] || await ctx.newPage();
    const cap = new Capture({ newPage: async () => page } as any);
    if (label) { const s = new SessionStore(); await s.injectPlaywright(ctx, label).catch(() => {}); }
    return new WSession(ctx, page, label, cap);
  }

  async goto(url: string): Promise<string> {
    return this._action(`goto_${url.split('/').pop()?.slice(0,20)}`, async () => {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitCloudflare(asV(this.page)).catch(() => {});
      return `navigated to ${this.page.url?.() ?? url}`;
    });
  }

  async click(target: string): Promise<string> {
    return this._action(`click_${target}`, async () => {
      const coords = await findClickTarget(asV(this.page), target);
      if (coords) { await humanClick(this.page, coords.x, coords.y); return `clicked ${target}`; }
      const r = await this.page.evaluate(`(()=>{function F(r,s){var a=Array.from(r.querySelectorAll(s));r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot)a=a.concat(F(e.shadowRoot,s))});return a}var t=${JSON.stringify(target.toLowerCase())};var sr=F(document,'[data-post-click-location] button');if(t.indexOf('upvote')>=0&&sr.length>0){sr[0].click();return'clicked upvote (shadow)'}var bs=F(document,'button,a,[role="button"]');for(var i=0;i<bs.length;i++){var x=((bs[i].textContent||'')+(bs[i].getAttribute('aria-label')||'')).toLowerCase();if(x.indexOf(t)>=0){bs[i].click();return'clicked: '+x.slice(0,40)}}return null})()`).catch(() => null);
      return r ?? 'no-target-found';
    });
  }

  async fill(target: string, value: string): Promise<string> {
    return this._action(`fill_${target}`, async () => {
    const v = this._resolveEnv(value);
    const kws = target.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
    const sels = kws.flatMap(k => ['input','textarea','[contenteditable]'].flatMap(t => [`${t}[name*="${k}"]`,`${t}[placeholder*="${k}" i]`,`${t}[aria-label*="${k}" i]`]));
    for (const sel of sels) { try { const el = this.page.locator?.(sel)?.first?.(); if (el && await el.isVisible()) { await el.fill(v); return 'filled'; } } catch {} }
    const tgt = JSON.stringify(target.toLowerCase());
    const c = await this.page.evaluate(`(()=>{var t=${tgt};for(var el of document.querySelectorAll('*')){var r=el.getBoundingClientRect();var ph=(el.getAttribute('placeholder')||'').toLowerCase();if(r.width>50&&r.height>10&&r.x>0&&ph&&ph.indexOf(t)>=0)return{x:r.x+r.width/2,y:r.y+r.height/2}}return null})()`).catch(() => null);
    if (c) { await humanClick(this.page, c.x, c.y); await this.page.keyboard.type(v, { delay: 30 }); return 'filled'; }
    const vc = await findClickTarget(asV(this.page), target);
    if (vc) { await humanClick(this.page, vc.x, vc.y); await this.page.keyboard.press('Meta+a').catch(() => {}); await this.page.keyboard.type(v, { delay: 30 }); return 'filled'; }
    return 'no-field-found';
    });
  }

  async focus(selector: string): Promise<string> {
    return this._action(`focus_${selector}`, async () => {
      const simple = selector.split(' ').pop()?.toLowerCase().replace(/['"[\]]/g, '') ?? '';
      const candidates = [selector, `input[name="${selector}"]`, `input[type="${selector}"]`, `input[placeholder*="${selector}" i]`];
      if (simple && simple !== selector) candidates.push(`input[name="${simple}"]`, `input[placeholder*="${simple}" i]`);
      for (const sel of candidates) {
        try {
          const found = await this.page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) { el.focus(); el.click(); return true; } return false; })()`);
          if (found) return `focused: ${sel}`;
        } catch { /* skip */ }
      }
      return 'no-element-found';
    });
  }

  async jsClick(selector?: string, text?: string): Promise<string> {
    return this._action(`jsClick_${text ?? selector}`, async () => {
      const sel = JSON.stringify(selector ?? ''), txt = JSON.stringify((text ?? '').toLowerCase());
      // Shadow DOM deep search (Reddit vote buttons)
      const sr = await this.page.evaluate(`(()=>{var t=${txt};function F(r){var a=[];r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot){var sr=e.shadowRoot;a=a.concat(Array.from(sr.querySelectorAll('[data-post-click-location] button')));a=a.concat(F(sr))}});return a}var bs=F(document);if(t&&t.indexOf('upvote')>=0&&bs.length>0){bs[0].click();return'clicked upvote (shadow)'}if(t&&t.indexOf('downvote')>=0&&bs.length>1){bs[1].click();return'clicked downvote (shadow)'}return null})()`).catch(() => null);
      if (sr) return sr;
      // Regular DOM: selector match, then text match
      const r = await this.page.evaluate(`(()=>{function F(r,s){var a=Array.from(r.querySelectorAll(s));r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot)a=a.concat(F(e.shadowRoot,s))});return a}var s=${sel},t=${txt};if(s){try{var e=F(document,s)[0];if(e){e.click();return'clicked: '+s}}catch(e){}}if(t){var els=F(document,'button,a,[role="button"],[class*="vote"],[class*="like"],[class*="star"],[class*="follow"]');for(var i=0;i<els.length;i++){var x=((els[i].textContent||'')+(els[i].getAttribute('aria-label')||'')).toLowerCase();if(x.indexOf(t)>=0){els[i].click();return'clicked: '+(els[i].getAttribute('aria-label')||els[i].textContent||'').trim().slice(0,40)}}}return null})()`).catch(() => null);
      return r ?? 'no-element-found';
    });
  }

  async type(value: string): Promise<string> { return this._action('type', async () => { await this.page.keyboard.type(this._resolveEnv(value), { delay: 30 }); return 'typed'; }); }
  async press(key: string): Promise<string> { return this._action(`press_${key}`, async () => { await this.page.keyboard.press(key); return `pressed ${key}`; }); }

  async select(target: string, value: string): Promise<string> {
    return this._action(`select_${target}_${value}`, async () => {
      const vl = JSON.stringify(value.toLowerCase());
      // Native <select>
      const native = await this.page.evaluate(`(()=>{var v=${vl};var ss=document.querySelectorAll('select');for(var i=0;i<ss.length;i++){var s=ss[i];for(var j=0;j<s.options.length;j++){if(s.options[j].text.toLowerCase().indexOf(v)>=0){s.selectedIndex=j;s.dispatchEvent(new Event('change',{bubbles:true}));return s.options[j].text}}}return null})()`).catch(() => null);
      if (native) return `selected: ${native}`;
      // Custom div dropdowns
      const tgtLow = JSON.stringify(target.toLowerCase());
      const opened = await this.page.evaluate(`(()=>{var tgt=${tgtLow};var els=document.querySelectorAll('[class*="select"],[class*="Select"],[class*="dropdown"],[class*="Dropdown"]');for(var i=0;i<els.length;i++){var t=els[i].textContent.trim().toLowerCase();if(t.indexOf(tgt)===0||t===tgt){els[i].click();return true}}return false})()`).catch(() => false);
      if (opened) {
        await new Promise(r => setTimeout(r, 500));
        const clicked = await this.page.evaluate(`(()=>{var v=${vl};var items=document.querySelectorAll('[role="option"],[class*="option"],[class*="Option"],li');for(var i=0;i<items.length;i++){var t=items[i].textContent.trim().toLowerCase();if(t===v&&items[i].children.length===0){items[i].click();return items[i].textContent.trim()}}for(var i=0;i<items.length;i++){var t=items[i].textContent.trim().toLowerCase();if(t.indexOf(v)>=0&&items[i].children.length===0){items[i].click();return items[i].textContent.trim()}}return null})()`).catch(() => null);
        if (clicked) return `selected: ${clicked}`;
      }
      return 'no-select-found';
    });
  }

  async scroll(direction: string, amount?: number): Promise<string> {
    return this._action(`scroll_${direction}`, async () => {
      const delta = (direction === 'up' ? -(amount ?? 400) : (amount ?? 400));
      await this.page.evaluate(`window.scrollBy(0, ${delta})`);
      return `scrolled ${direction} ${amount ?? 400}`;
    });
  }

  async wait(seconds: number): Promise<string> { await new Promise(r => setTimeout(r, seconds * 1000)); return `waited ${seconds}s`; }
  async read(question: string): Promise<string> { return await askPage(asV(this.page), question) ?? 'NONE'; }
  async solveCaptcha(): Promise<string> { return this._action('solveCaptcha', async () => (await solvePageCaptcha(this.page, this._solver)) ? 'captcha solved' : 'captcha failed'); }

  async checkEmail(email: string, sender: string): Promise<string> {
    const key = process.env.RESEND_RECEIVING_API_KEY ?? '';
    if (!key) return 'error: no RESEND_RECEIVING_API_KEY';
    const addr = this._resolveEnv(email).toLowerCase();
    for (let i = 0; i < 30; i++) {
      const r = await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${key}` } });
      for (const em of ((await r.json()) as any).data ?? []) {
        const to = (em.to ?? []).map((t: any) => (typeof t === 'string' ? t : t.email ?? '').toLowerCase());
        if (!to.includes(addr)) continue;
        if (sender && !(em.from ?? '').toLowerCase().includes(sender)) continue;
        const d = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${key}` } })).json() as any;
        const codes = `${d.subject ?? ''} ${d.text ?? ''} ${d.html ?? ''}`.match(/\b\d{5,6}\b/g);
        if (codes) return codes[0];
      }
      await new Promise(r => setTimeout(r, 10000));
    }
    return 'no code received';
  }

  async generateIdentity(platform: string): Promise<Identity> {
    const id = await genId(platform);
    const k = platform.toUpperCase();
    this._env[`${k}_NEW_USERNAME`] = id.username;
    this._env[`${k}_NEW_EMAIL`] = id.email;
    this._env[`${k}_NEW_PASSWORD`] = id.password;
    this._env[`${k}_NEW_FIRSTNAME`] = id.firstName;
    this._env[`${k}_NEW_LASTNAME`] = id.lastName;
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
    const username = this._resolveEnv(data.username);
    const email = this._resolveEnv(data.email);
    const password = this._resolveEnv(data.password);
    const name = data.name ? this._resolveEnv(data.name) : undefined;
    const cookies = await this.ctx.cookies().catch(() => []);
    const row = {
      platform,
      username,
      display_name: name,
      profile_url: profileUrl(platform, username, name),
      metadata: { email, password, status: data.status ?? 'created', created_via: 'weles', cookies, cookies_updated_at: new Date().toISOString() },
      is_active: true,
      created_by: 'weles',
    };
    const res = await fetch(`${url}/rest/v1/social_accounts`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!res.ok) return `error: ${res.status} ${await res.text().catch(() => '')}`;
    return `account saved: ${platform}/${username}`;
  }

  async close(): Promise<void> {
    await this._cap.save('session', this.page).catch(() => {});
    const video = this.page.video?.();
    const dest = join(recordingsDir(), `${this.label || 'session'}_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);
    // Close page first to finalize video, then save with label, then close context
    await this.page.close().catch(() => {});
    if (video) {
      await video.saveAs(dest).catch(() => {
        // Direct file copy if saveAs fails after page close
        try { const src = video.path?.() as string | undefined; if (src) copyFileSync(src, dest); } catch {}
      });
    }
    await this.ctx.close().catch(() => {});
  }

  resolveEnv(v: string): string { return v.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_, k) => this._env[k] ?? process.env[k] ?? v); }
  private _resolveEnv(v: string): string { return this.resolveEnv(v); }
}

function profileUrl(platform: string, username: string, name?: string): string {
  const urls: Record<string, string> = {
    reddit: `https://reddit.com/u/${username}`, tiktok: `https://tiktok.com/@${username}`,
    github: `https://github.com/${username}`, discord: `https://discord.com/users/${username}`,
    linkedin: `https://linkedin.com/in/${(name ?? username).toLowerCase().replace(/\s+/g, '-')}`,
    instagram: `https://instagram.com/${username}`, twitter: `https://x.com/${username}`,
  };
  return urls[platform] ?? '';
}
