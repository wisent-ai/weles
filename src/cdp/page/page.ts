import { CDPConnection } from '../connection.js';
import { CDPError, CDPNavigationError } from '../errors.js';
import { CDPFrame, FrameTree } from './frame.js';
import { CDPMouse, CDPKeyboard } from '../input.js';

type EventHandler = (data?: any) => void;

interface GotoOptions {
  waitUntil?: 'load' | 'domcontentloaded';
  timeout?: number;
}

interface ScreenshotOptions {
  path?: string;
  fullPage?: boolean;
  format?: string;
}

interface WaitForSelectorOptions {
  state?: 'visible' | 'attached' | 'detached' | 'hidden';
  timeout?: number;
}

class _Route {
  readonly request: Record<string, any>;
  private _conn: CDPConnection;
  private _sessionId: string;
  private _requestId: string;

  constructor(conn: CDPConnection, sessionId: string, params: any) {
    this._conn = conn;
    this._sessionId = sessionId;
    this.request = params.request ?? {};
    this._requestId = params.requestId ?? '';
  }

  async abort(reason = 'Failed'): Promise<void> {
    await this._conn.send('Fetch.failRequest', {
      requestId: this._requestId,
      errorReason: reason,
    }, this._sessionId);
  }

  async fulfill(options: { status?: number; headers?: Record<string, string>; body?: string } = {}): Promise<void> {
    const { status = 200, headers = {}, body = '' } = options;
    const h = Object.entries(headers).map(([name, value]) => ({ name, value }));
    await this._conn.send('Fetch.fulfillRequest', {
      requestId: this._requestId,
      responseCode: status,
      responseHeaders: h,
      body: Buffer.from(body).toString('base64'),
    }, this._sessionId);
  }

  async continue_(): Promise<void> {
    await this._conn.send('Fetch.continueRequest', {
      requestId: this._requestId,
    }, this._sessionId);
  }
}

function selectorCheck(selector: string, state: string): string {
  let base: string;
  if (selector.startsWith('xpath=')) {
    const xp = selector.slice(6);
    base = `document.evaluate(${JSON.stringify(xp)},document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue`;
  } else {
    base = `document.querySelector(${JSON.stringify(selector)})`;
  }
  return state === 'detached' || state === 'hidden' ? `!(${base})` : `!!(${base})`;
}

export class CDPPage {
  private _conn: CDPConnection;
  private _targetId: string;
  private _sessionId: string;
  private _context: any;
  private _ft: FrameTree;
  private _initScripts: string[] = [];
  private _routes: Array<{ pattern: RegExp; handler: (route: _Route) => Promise<void> }> = [];
  private _handlers = new Map<string, EventHandler[]>();
  private _loadResolvers: Array<() => void> = [];
  private _dcResolvers: Array<() => void> = [];
  private _loadFired = false;
  private _dcFired = false;
  private _mouse: CDPMouse | null = null;
  private _keyboard: CDPKeyboard | null = null;
  private _recordVideo: any;
  private _video: any = null;
  private _closed = false;

  constructor(
    connection: CDPConnection,
    targetId: string,
    sessionId: string,
    context?: any,
    recordVideo?: any,
  ) {
    this._conn = connection;
    this._targetId = targetId;
    this._sessionId = sessionId;
    this._context = context ?? null;
    this._recordVideo = recordVideo ?? null;
    this._ft = new FrameTree(connection, sessionId);

    this._conn.on('Page.loadEventFired', () => {
      this._loadFired = true;
      for (const r of this._loadResolvers) r();
      this._loadResolvers = [];
      this._fire('load');
    }, sessionId);

    this._conn.on('Page.domContentEventFired', () => {
      this._dcFired = true;
      for (const r of this._dcResolvers) r();
      this._dcResolvers = [];
      this._fire('domcontentloaded');
    }, sessionId);
  }

  get url(): string {
    return this._ft.mainFrame?.url ?? '';
  }

  get frames(): CDPFrame[] {
    return this._ft.frames;
  }

  get mainFrame(): CDPFrame | null {
    return this._ft.mainFrame;
  }

  get context(): any {
    return this._context;
  }

  get video(): any {
    return this._video;
  }

  get mouse(): CDPMouse {
    if (!this._mouse) this._mouse = new CDPMouse(this._conn, this._sessionId);
    return this._mouse;
  }

  get keyboard(): CDPKeyboard {
    if (!this._keyboard) this._keyboard = new CDPKeyboard(this._conn, this._sessionId);
    return this._keyboard;
  }

  async init(): Promise<void> {
    await this._conn.send('Page.enable', undefined, this._sessionId);
    await this._conn.send('Network.enable', undefined, this._sessionId);
    const tree = await this._conn.send('Page.getFrameTree', undefined, this._sessionId);
    const root = tree?.frameTree?.frame ?? {};
    this._ft.setMainFrame(root.id ?? '', root.url ?? '');
    this._conn.on('Network.responseReceived', (p: any) => this._fire('response', p), this._sessionId);
  }

  async goto(url: string, options?: GotoOptions): Promise<void> {
    const waitUntil = options?.waitUntil ?? 'load';
    this._loadFired = false;
    this._dcFired = false;
    const r = await this._conn.send('Page.navigate', { url }, this._sessionId);
    if (r?.errorText) {
      throw new CDPNavigationError(`Navigation failed: ${r.errorText}`);
    }
    await this._waitForLoadState(waitUntil);
  }

  async reload(): Promise<void> {
    this._loadFired = false;
    this._dcFired = false;
    await this._conn.send('Page.reload', undefined, this._sessionId);
    await this._waitForLoadState('load');
  }

  async goBack(): Promise<void> {
    const h = await this._conn.send('Page.getNavigationHistory', undefined, this._sessionId);
    const idx = h?.currentIndex ?? 0;
    if (idx > 0) {
      await this._conn.send('Page.navigateToHistoryEntry', {
        entryId: h.entries[idx - 1].id,
      }, this._sessionId);
    }
  }

  async evaluate(expression: string, arg?: any): Promise<any> {
    const mf = this._ft.mainFrame;
    if (!mf) throw new CDPError('No main frame');
    return mf.evaluate(expression, arg);
  }

  async content(): Promise<string> {
    const mf = this._ft.mainFrame;
    if (!mf) throw new CDPError('No main frame');
    const r = await this._conn.send('Page.getResourceContent', {
      frameId: mf.frameId,
      url: this.url,
    }, this._sessionId);
    return r?.content ?? '';
  }

  async title(): Promise<string> {
    const mf = this._ft.mainFrame;
    if (!mf) return '';
    return (await mf.evaluate('document.title')) ?? '';
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    const format = options?.format ?? 'png';
    const params: Record<string, any> = { format };
    if (options?.fullPage) {
      const m = await this._conn.send('Page.getLayoutMetrics', undefined, this._sessionId);
      const cs = m?.contentSize ?? {};
      params.clip = {
        x: 0,
        y: 0,
        scale: 1,
        width: cs.width ?? 1920,
        height: cs.height ?? 1080,
      };
    }
    const r = await this._conn.send('Page.captureScreenshot', params, this._sessionId);
    const buf = Buffer.from(r?.data ?? '', 'base64');
    if (options?.path) {
      const { writeFileSync } = require('node:fs');
      writeFileSync(options.path, buf);
    }
    return buf;
  }

  waitForTimeout(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<void> {
    const state = options?.state ?? 'visible';
    const js = selectorCheck(selector, state);
    const mf = this._ft.mainFrame;
    if (!mf) throw new CDPError('No main frame');
    while (!await mf.evaluate(js)) {
      await this.waitForTimeout(100);
    }
  }

  async waitForLoadState(state: 'load' | 'domcontentloaded' = 'load'): Promise<void> {
    return this._waitForLoadState(state);
  }

  async waitForUrl(urlOrPattern: string | RegExp): Promise<void> {
    while (true) {
      const cur = this.url;
      if (urlOrPattern instanceof RegExp) {
        if (urlOrPattern.test(cur)) return;
      } else {
        if (cur.includes(urlOrPattern)) return;
      }
      await this.waitForTimeout(100);
    }
  }

  async addInitScript(script: string): Promise<void> {
    this._initScripts.push(script);
    await this._conn.send('Page.addScriptToEvaluateOnNewDocument', {
      source: script,
      worldName: '',
    }, this._sessionId);
  }

  async route(pattern: string, handler: (route: _Route) => Promise<void>): Promise<void> {
    if (this._routes.length === 0) {
      await this._conn.send('Fetch.enable', {
        patterns: [{ urlPattern: '*' }],
      }, this._sessionId);
      this._conn.on('Fetch.requestPaused', (params: any) => {
        this._onRequestPaused(params);
      }, this._sessionId);
    }
    this._routes.push({ pattern: new RegExp(pattern), handler });
  }

  on(event: string, handler: EventHandler): void {
    const list = this._handlers.get(event);
    if (list) {
      list.push(handler);
    } else {
      this._handlers.set(event, [handler]);
    }
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    try {
      await this._conn.send('Target.closeTarget', { targetId: this._targetId });
    } catch {
      // target may already be closed
    }
  }

  private _fire(name: string, data?: any): void {
    const handlers = this._handlers.get(name);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(data); } catch { /* listener errors silently dropped */ }
    }
  }

  private _waitForLoadState(state: string): Promise<void> {
    if (state === 'domcontentloaded' && this._dcFired) return Promise.resolve();
    if ((state === 'load' || state === 'networkidle') && this._loadFired) return Promise.resolve();
    return new Promise(resolve => {
      if (state === 'domcontentloaded') {
        this._dcResolvers.push(resolve);
      } else {
        this._loadResolvers.push(resolve);
      }
    });
  }

  private async _onRequestPaused(params: any): Promise<void> {
    const url: string = params.request?.url ?? '';
    const requestId: string = params.requestId ?? '';
    for (const { pattern, handler } of this._routes) {
      if (pattern.test(url)) {
        await handler(new _Route(this._conn, this._sessionId, params));
        return;
      }
    }
    await this._conn.send('Fetch.continueRequest', { requestId }, this._sessionId);
  }
}
