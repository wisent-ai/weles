/**
 * Declarative Task runner — 1:1 port of weles/agent/tasks.py
 *
 * FetchAccountValue: which account, where to start, what to extract.
 * Runner handles browser lifecycle, cookies, Cloudflare, login, discovery.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as discover from './discover.js';
import * as login from './login.js';
import * as vision from './vision.js';
import { waitCloudflare } from '../cloudflare/challenge.js';
import { SessionStore } from '../session/store.js';

// ---------------------------------------------------------------------------
// Trajectory cache
// ---------------------------------------------------------------------------

function cacheDir(): string {
  const base = process.env.WELES_CACHE_DIR ?? join(homedir(), '.weles');
  const dir = join(base, 'trajectories');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class Trajectory {
  service: string;
  finalUrl: string;
  selector: string | null;
  regex: string | null;
  lastSuccess: string | null;
  lastValue: number | null;

  constructor(data: Partial<Trajectory> & { service: string; finalUrl: string }) {
    this.service = data.service;
    this.finalUrl = data.finalUrl;
    this.selector = data.selector ?? null;
    this.regex = data.regex ?? null;
    this.lastSuccess = data.lastSuccess ?? null;
    this.lastValue = data.lastValue ?? null;
  }

  static load(service: string): Trajectory | null {
    try {
      const raw = readFileSync(join(cacheDir(), `${service}.json`), 'utf-8');
      return new Trajectory(JSON.parse(raw));
    } catch { return null; }
  }

  save(): void {
    try {
      writeFileSync(join(cacheDir(), `${this.service}.json`), JSON.stringify(this, null, 2));
    } catch { /* skip */ }
  }

  static invalidate(service: string): void {
    try { unlinkSync(join(cacheDir(), `${service}.json`)); } catch { /* skip */ }
  }
}

// ---------------------------------------------------------------------------
// FetchAccountValue
// ---------------------------------------------------------------------------

export interface FetchAccountValueConfig {
  service: string;
  url: string;
  what: string;
  usernameEnv: string;
  passwordEnv: string;
  osTarget?: string;
  depth?: number;
}

export class FetchAccountValue {
  service: string;
  url: string;
  what: string;
  usernameEnv: string;
  passwordEnv: string;
  osTarget: string;
  depth: number;

  constructor(config: FetchAccountValueConfig) {
    this.service = config.service;
    this.url = config.url;
    this.what = config.what;
    this.usernameEnv = config.usernameEnv;
    this.passwordEnv = config.passwordEnv;
    this.osTarget = config.osTarget ?? 'macos';
    this.depth = config.depth ?? 4;
  }

  async run(): Promise<number | null> {
    const traj = Trajectory.load(this.service);
    if (traj) {
      const replayValue = await this._replayTrajectory(traj);
      if (replayValue !== null) {
        console.log(`[task] ${this.service}: cache replay hit, value=${replayValue}`);
        traj.lastValue = replayValue;
        traj.lastSuccess = new Date().toISOString();
        traj.save();
        return replayValue;
      }
      console.log(`[task] ${this.service}: cache replay missed, invalidating`);
      Trajectory.invalidate(this.service);
    }

    const bal = await this._attemptWithExistingSession();
    if (bal !== null) return bal;
    console.log(`[task] ${this.service}: first attempt returned null, clearing cookies`);
    this._clearCookies();
    return this._attemptWithExistingSession();
  }

  private async _replayTrajectory(traj: Trajectory): Promise<number | null> {
    const cookies = this._loadCookies();
    const page = await openSession(this.osTarget);
    try {
      if (cookies) await page.context().addCookies(cookies);
      await page.goto(traj.finalUrl, { waitUntil: 'domcontentloaded' });
      await waitCloudflare(page);
      if (page.url().toLowerCase().includes('login') || page.url().toLowerCase().includes('signin')) return null;
      if (!traj.selector) return null;
      const el = await page.querySelector(traj.selector);
      if (!el) return null;
      let text = ((await el.innerText()) ?? '').trim();
      if (traj.regex) {
        const m = text.match(new RegExp(traj.regex));
        if (m) text = m[1] ?? m[0];
      }
      const cleaned = text.replace(/[^\d.\-]/g, '');
      if (!cleaned) return null;
      return parseFloat(cleaned);
    } catch (e: any) {
      console.log(`[task] ${this.service}: replay error: ${e.message}`);
      return null;
    } finally {
      await closeSession(page);
    }
  }

  private async _attemptWithExistingSession(): Promise<number | null> {
    const cookies = this._loadCookies();
    const page = await openSession(this.osTarget);
    try {
      if (cookies) await page.context().addCookies(cookies);
      await page.goto(this.url, { waitUntil: 'domcontentloaded' });
      await waitCloudflare(page);
      if (await this._isLoginPage(page)) {
        if (!await this._loginInline(page)) return null;
      }
      const value = await this._extractValue(page);
      if (value !== null) await this._learnTrajectory(page, value);
      return value;
    } catch (e: any) {
      console.log(`[task] ${this.service}: attempt error: ${e.message}`);
      return null;
    } finally {
      await closeSession(page);
    }
  }

  private async _isLoginPage(page: any): Promise<boolean> {
    const url = page.url().toLowerCase();
    if (url.includes('login') || url.includes('signin') || url.includes('sign-in')) return true;
    return vision.boolean(page,
      'Is this page showing a login form with username and '
      + 'password fields, or a "Sign in" / "Log in" button as '
      + 'the main call to action?');
  }

  private async _loginInline(page: any): Promise<boolean> {
    const username = process.env[this.usernameEnv] ?? '';
    const password = process.env[this.passwordEnv] ?? '';
    if (!username || !password) {
      console.log(`[task] ${this.service}: missing credentials (${this.usernameEnv}, ${this.passwordEnv})`);
      return false;
    }
    const ok = await login.run(page, username, password);
    if (!ok) return false;
    this._saveCookies(await page.context().cookies());
    return true;
  }

  private async _learnTrajectory(page: any, value: number): Promise<void> {
    try {
      const selAnswer = await vision.text(page,
        `a CSS selector that uniquely identifies the element containing ${this.what}`);
      const selector = (selAnswer ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
      if (selector && selector.length < 200) {
        new Trajectory({
          service: this.service,
          finalUrl: page.url(),
          selector,
          regex: '\\$?\\s*([0-9]+(?:\\.[0-9]+)?)',
          lastSuccess: new Date().toISOString(),
          lastValue: value,
        }).save();
        console.log(`[task] ${this.service}: trajectory cached (url=${page.url()}, selector=${JSON.stringify(selector)})`);
      }
    } catch (e: any) {
      console.log(`[task] ${this.service}: could not learn trajectory: ${e.message}`);
    }
  }

  private async _extractValue(page: any): Promise<number | null> {
    return discover.findNumber(page, this.what, this.depth);
  }

  private _loadCookies(): any[] | null {
    try { return new SessionStore().loadCookies(this.service); } catch { return null; }
  }

  private _saveCookies(cookies: any[]): void {
    try { new SessionStore().saveCookies(this.service, cookies); } catch { /* skip */ }
  }

  private _clearCookies(): void {
    try { new SessionStore().saveCookies(this.service, []); } catch { /* skip */ }
  }
}

// ---------------------------------------------------------------------------
// Session management — uses AsyncNewBrowser (same as Python _open_session)
// ---------------------------------------------------------------------------

function _getProxy(): { server: string; username: string; password: string } | undefined {
  const providers: Array<[string, string, string, (u: string, p: string) => [string, string]]> = [
    ['OXYLABS_USERNAME', 'OXYLABS_PASSWORD', 'http://pr.oxylabs.io:7777', (u, p) => [`customer-${u}-cc-US`, p]],
    ['PINGPROXIES_USERNAME', 'PINGPROXIES_PASSWORD', 'http://residential.pingproxies.com:8000', (u, p) => [`${u}_c_us`, p]],
    ['PACKETSTREAM_USERNAME', 'PACKETSTREAM_PASSWORD', 'http://proxy.packetstream.io:31112', (u, p) => [u, `${p}_country-US`]],
  ];
  for (const [uEnv, pEnv, server, build] of providers) {
    const u = process.env[uEnv], p = process.env[pEnv];
    if (u && p) { const [user, pass] = build(u, p); return { server, username: user, password: pass }; }
  }
  return undefined;
}

async function openSession(osTarget: string): Promise<any> {
  const { AsyncNewBrowser } = await import('../async_api.js');
  const proxy = _getProxy();
  const context = await AsyncNewBrowser({
    os: osTarget,
    browser: 'chromium',
    headless: false,
    proxy,
  });
  const page = context.pages()[0] ?? await context.newPage();
  return page;
}

async function closeSession(page: any): Promise<void> {
  try { await page.context().close(); } catch { /* skip */ }
}
