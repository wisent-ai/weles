import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Minimal type interfaces
// ---------------------------------------------------------------------------

export interface SessionContext {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

export interface CookieParam {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  private _persistPath: string;

  constructor(persistPath?: string) {
    this._persistPath = persistPath ?? join(homedir(), '.weles', 'sessions.json');
  }

  // -----------------------------------------------------------------------
  // Low-level persistence
  // -----------------------------------------------------------------------

  private _readStore(): Record<string, CookieParam[]> {
    if (!existsSync(this._persistPath)) {
      return {};
    }
    try {
      const raw = readFileSync(this._persistPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private _writeStore(store: Record<string, CookieParam[]>): void {
    mkdirSync(dirname(this._persistPath), { recursive: true });
    writeFileSync(this._persistPath, JSON.stringify(store, null, 2));
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Persist an array of cookies under the given label.
   */
  saveCookies(label: string, cookies: CookieParam[]): void {
    const store = this._readStore();
    store[label] = cookies;
    this._writeStore(store);
  }

  /**
   * Retrieve previously saved cookies, or `null` if the label is unknown.
   */
  loadCookies(label: string): CookieParam[] | null {
    const store = this._readStore();
    return store[label] ?? null;
  }

  /**
   * Inject stored cookies into a browser context via the CDP
   * `Network.setCookie` command.
   */
  async inject(context: SessionContext, label: string): Promise<void> {
    const cookies = this.loadCookies(label);
    if (!cookies || cookies.length === 0) return;

    for (const cookie of cookies) {
      await context.send('Network.setCookie', cookie);
    }
  }

  /**
   * Extract all cookies from a browser context and persist them under the
   * given label.
   */
  async capture(context: SessionContext, label: string): Promise<void> {
    const result = await context.send('Network.getAllCookies');
    const cookies: CookieParam[] = result?.cookies ?? [];
    this.saveCookies(label, cookies);
  }

  /** Inject cookies into a Playwright BrowserContext (uses addCookies API). */
  async injectPlaywright(context: { addCookies(cookies: any[]): Promise<void> }, label: string): Promise<boolean> {
    const cookies = this.loadCookies(label);
    if (!cookies || cookies.length === 0) return false;
    const valid = cookies.filter(c => c.name && c.value && c.domain);
    await context.addCookies(valid);
    return valid.length > 0;
  }

  /** Capture cookies from a Playwright BrowserContext and persist them. */
  async capturePlaywright(context: { cookies(): Promise<any[]> }, label: string): Promise<CookieParam[]> {
    const cookies = await context.cookies();
    this.saveCookies(label, cookies);
    return cookies;
  }
}
