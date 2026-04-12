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
}

export class CDPBrowserContext {
  private _connection: CDPConnection;
  private _browserContextId: string;
  private _recordVideo: boolean;
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

  async newPage(): Promise<CDPPage> {
    // Create a new target within this browser context
    const { targetId } = await this._connection.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId: this._browserContextId,
    });

    // Attach to the target to get a session
    const { sessionId } = await this._connection.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    // Create the CDPPage and initialise it
    const page = new CDPPage(this._connection, targetId, sessionId, this);
    await page.init();

    // Apply emulation settings
    await this._connection.send(
      'Emulation.setUserAgentOverride',
      {
        userAgent: this._emulation.userAgent,
        acceptLanguage: this._emulation.acceptLanguage,
        platform: this._emulation.platform,
      },
      sessionId,
    );

    await this._connection.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: this._emulation.viewportWidth,
        height: this._emulation.viewportHeight,
        deviceScaleFactor: this._emulation.deviceScaleFactor,
        mobile: false,
      },
      sessionId,
    );

    // Inject all queued init scripts
    for (const script of this._initScripts) {
      await this._connection.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: script },
        sessionId,
      );
    }

    this._pages.push(page);
    return page;
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
