import { CDPConnection } from '../cdp/connection.js';
import { CDPPage } from '../cdp/page/page.js';

export interface EmulationSettings {
  userAgent: string;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
  acceptLanguage: string;
  platform: string;
}

export interface BrowserContextOptions {
  recordVideo?: boolean;
  proxyAuth?: { username: string; password: string };
}

export class CDPBrowserContext {
  private _connection: CDPConnection;
  private _browserContextId: string;
  private _recordVideo: boolean;
  private _proxyAuth?: { username: string; password: string };
  private _pages: CDPPage[] = [];
  private _initScripts: string[] = [];
  _emulation: EmulationSettings = {
    userAgent: '',
    viewportWidth: 1280,
    viewportHeight: 720,
    deviceScaleFactor: 1,
    acceptLanguage: 'en-US',
    platform: 'MacIntel',
  };

  constructor(
    connection: CDPConnection,
    browserContextId: string,
    options?: BrowserContextOptions,
  ) {
    this._connection = connection;
    this._browserContextId = browserContextId;
    this._recordVideo = options?.recordVideo ?? false;
    this._proxyAuth = options?.proxyAuth;
  }

  setEmulation(options: Partial<EmulationSettings>): void {
    if (options.userAgent !== undefined) this._emulation.userAgent = options.userAgent;
    if (options.viewportWidth !== undefined) this._emulation.viewportWidth = options.viewportWidth;
    if (options.viewportHeight !== undefined) this._emulation.viewportHeight = options.viewportHeight;
    if (options.deviceScaleFactor !== undefined) this._emulation.deviceScaleFactor = options.deviceScaleFactor;
    if (options.acceptLanguage !== undefined) this._emulation.acceptLanguage = options.acceptLanguage;
    if (options.platform !== undefined) this._emulation.platform = options.platform;
  }

  addInitScript(script: string): void {
    this._initScripts.push(script);
  }

  private async _initPage(targetId: string, sessionId: string): Promise<CDPPage> {
    const page = new CDPPage(this._connection, targetId, sessionId, this);
    await page.init();
    await this._connection.send('Emulation.setUserAgentOverride', {
      userAgent: this._emulation.userAgent, acceptLanguage: this._emulation.acceptLanguage, platform: this._emulation.platform,
    }, sessionId);
    await this._connection.send('Emulation.setDeviceMetricsOverride', {
      width: this._emulation.viewportWidth, height: this._emulation.viewportHeight,
      deviceScaleFactor: this._emulation.deviceScaleFactor, mobile: false,
    }, sessionId);
    for (const script of this._initScripts) {
      await this._connection.send('Page.addScriptToEvaluateOnNewDocument', { source: script }, sessionId);
    }
    this._pages.push(page);
    return page;
  }

  async newPage(): Promise<CDPPage> {
    const { targetId } = await this._connection.send('Target.createTarget', {
      url: 'about:blank', browserContextId: this._browserContextId,
    });
    const { sessionId } = await this._connection.send('Target.attachToTarget', { targetId, flatten: true });
    const page = await this._initPage(targetId, sessionId);
    // Auto-attach to popups opened from this page
    await this._connection.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    }, sessionId);
    this._connection.on('Target.attachedToTarget', (params: any) => {
      const info = params.targetInfo ?? {};
      if (info.type === 'page' && info.browserContextId === this._browserContextId) {
        this._initPage(info.targetId, params.sessionId).catch(() => {});
      }
    }, sessionId);
    return page;
  }

  /** Wait for a popup page to appear (e.g. Google SSO). Returns the newest page. */
  async waitForPopup(ms = 10000): Promise<CDPPage | null> {
    const start = Date.now();
    const initial = this._pages.length;
    while (Date.now() - start < ms) {
      if (this._pages.length > initial) return this._pages[this._pages.length - 1];
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  async addCookies(cookies: Array<Record<string, unknown>>): Promise<void> {
    for (const cookie of cookies) {
      const c = { ...cookie };
      if (!c.url && c.domain) {
        const scheme = c.secure ? 'https' : 'http';
        const domain = String(c.domain).replace(/^\./, '');
        c.url = `${scheme}://${domain}${c.path ?? '/'}`;
      }
      await this._connection.send('Network.setCookie', c);
    }
  }

  async cookies(urls?: string[]): Promise<Array<Record<string, unknown>>> {
    const params: Record<string, any> = {};
    if (urls) params.urls = urls;
    const { cookies } = await this._connection.send('Network.getCookies', params);
    return cookies;
  }

  async clearCookies(): Promise<void> {
    await this._connection.send('Network.clearBrowserCookies', {});
  }

  async close(): Promise<void> {
    // Close all pages
    for (const page of this._pages) {
      try {
        await page.close();
      } catch {
        // page may already be closed
      }
    }
    this._pages = [];

    // Dispose the browser context
    await this._connection.send('Target.disposeBrowserContext', {
      browserContextId: this._browserContextId,
    });
  }

  get pages(): readonly CDPPage[] {
    return this._pages;
  }

  get browserContextId(): string {
    return this._browserContextId;
  }
}
