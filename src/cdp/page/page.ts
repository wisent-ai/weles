import { CDPConnection } from '../connection.js';
import { CDPError, CDPNavigationError } from '../errors.js';
import { CDPFrame, FrameTree } from './frame.js';
import { CDPMouse, CDPKeyboard } from '../input.js';
import { CDPScreencast } from './screencast.js';
import { FetchInterception, type CDPRoute } from './fetch_interception.js';
import {
  captureScreenshot,
  waitForMainFrameUrl,
  waitForSelectorIn,
  type SelectorState,
} from './document.js';
import {
  LoadStates,
  PageEvents,
  type EventHandler,
  type LoadState,
} from './events/page-events.js';

export class CDPPage {
  private _conn: CDPConnection;
  private _targetId: string;
  private _sessionId: string;
  private _context: any;
  private _ft: FrameTree;
  private _initScripts: string[] = [];
  private _fetch: FetchInterception;
  private _events: PageEvents;
  private _loads = new LoadStates();
  private _mouse: CDPMouse | null = null;
  private _keyboard: CDPKeyboard | null = null;
  private _recordVideo: any;
  private _screencast: CDPScreencast | null = null;
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
    this._context = context;
    this._recordVideo = recordVideo;
    this._ft = new FrameTree(connection, sessionId);
    this._events = new PageEvents(connection, sessionId);

    this._fetch = new FetchInterception(connection, sessionId);
    this._conn.on(
      'Page.loadEventFired',
      () => {
        this._loads.fire('load');
        this._events.fire('load');
      },
      sessionId,
    );

    this._conn.on(
      'Page.domContentEventFired',
      () => {
        this._loads.fire('domcontentloaded');
        this._events.fire('domcontentloaded');
      },
      sessionId,
    );
  }

  get url(): string {
    return this._frame().url;
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
    return this._screencast?.video;
  }

  get mouse(): CDPMouse {
    if (!this._mouse) this._mouse = new CDPMouse(this._conn, this._sessionId);
    return this._mouse;
  }

  get keyboard(): CDPKeyboard {
    if (!this._keyboard)
      this._keyboard = new CDPKeyboard(this._conn, this._sessionId);
    return this._keyboard;
  }

  async init(): Promise<void> {
    await this._conn.send('Page.enable', undefined, this._sessionId);
    await this._conn.send('Network.enable', undefined, this._sessionId);
    const {
      frameTree: { frame },
    } = await this._conn.send('Page.getFrameTree', undefined, this._sessionId);
    this._ft.setMainFrame(frame.id, frame.url);
    this._conn.on(
      'Network.responseReceived',
      (p: any) => this._events.fire('response', p),
      this._sessionId,
    );
    if (this._recordVideo) {
      const dir =
        typeof this._recordVideo === 'object'
          ? this._recordVideo.dir
          : undefined;
      this._screencast = new CDPScreencast(this._conn, this._sessionId, {
        outputDir: dir,
      });
      await this._screencast.start();
    }
  }

  // waitUntil defaults to 'load', as the Playwright page interface does.
  async goto(
    url: string,
    { waitUntil = 'load' }: { waitUntil?: LoadState } = {},
  ): Promise<void> {
    this._loads.reset();
    const r = await this._conn.send('Page.navigate', { url }, this._sessionId);
    if (r.errorText) {
      throw new CDPNavigationError(`Navigation failed: ${r.errorText}`);
    }
    await this._loads.wait(waitUntil);
  }

  async reload(): Promise<void> {
    this._loads.reset();
    await this._conn.send('Page.reload', undefined, this._sessionId);
    await this._loads.wait('load');
  }

  // Goes to the history entry before the current one; a page at the start of
  // its history stays where it is, as the Playwright page interface does.
  async goBack(): Promise<void> {
    const { currentIndex, entries } = await this._conn.send(
      'Page.getNavigationHistory',
      undefined,
      this._sessionId,
    );
    const previous = entries.findLast(
      (_entry: unknown, index: number) => index < currentIndex,
    );
    if (!previous) return;
    await this._conn.send(
      'Page.navigateToHistoryEntry',
      { entryId: previous.id },
      this._sessionId,
    );
  }

  async evaluate(expression: string, arg?: any): Promise<any> {
    return this._frame().evaluate(expression, arg);
  }

  async content(): Promise<string> {
    const frame = this._frame();
    const { content } = await this._conn.send(
      'Page.getResourceContent',
      { frameId: frame.frameId, url: frame.url },
      this._sessionId,
    );
    return content;
  }

  async title(): Promise<string> {
    return this._frame().evaluate('document.title');
  }

  // format defaults to 'png', as the Playwright page interface does.
  async screenshot({
    path,
    fullPage,
    format = 'png',
  }: {
    path?: string;
    fullPage?: boolean;
    format?: string;
  } = {}): Promise<Buffer> {
    const options = { path, fullPage, format };
    return captureScreenshot(this._conn, this._sessionId, options);
  }

  // state defaults to 'visible', as the Playwright page interface does.
  async waitForSelector(
    selector: string,
    { state = 'visible' }: { state?: SelectorState } = {},
  ): Promise<void> {
    const { _conn, _sessionId, _ft } = this;
    return waitForSelectorIn(_conn, _sessionId, _ft, selector, state);
  }

  async waitForLoadState(state: LoadState = 'load'): Promise<void> {
    return this._loads.wait(state);
  }

  waitForUrl(urlOrPattern: string | RegExp): Promise<void> {
    const matches = (url: string) =>
      urlOrPattern instanceof RegExp
        ? urlOrPattern.test(url)
        : url.includes(urlOrPattern);
    if (matches(this.url)) return Promise.resolve();
    return waitForMainFrameUrl(this._conn, this._sessionId, this._ft, matches);
  }

  locator(selector: string): any {
    const { CDPLocator } = require('../dom/locator.js');
    return new CDPLocator(this.mainFrame, selector);
  }

  getByText(text: string, exact = false): any {
    return this.locator(
      exact
        ? `xpath=//text()[.="${text}"]/parent::*`
        : `xpath=//text()[contains(.,"${text}")]/parent::*`,
    );
  }

  async addInitScript(script: string): Promise<void> {
    this._initScripts.push(script);
    const params = { source: script, worldName: '' };
    await this._conn.send(
      'Page.addScriptToEvaluateOnNewDocument',
      params,
      this._sessionId,
    );
  }

  async setProxyAuth(credentials: {
    username: string;
    password: string;
  }): Promise<void> {
    await this._fetch.setProxyAuth(credentials);
  }

  async route(
    pattern: string,
    handler: (route: CDPRoute) => Promise<void>,
  ): Promise<void> {
    await this._fetch.route(pattern, handler);
  }

  on(event: string, handler: EventHandler): void {
    this._events.on(event, handler);
  }

  off(event: string, handler: EventHandler): void {
    this._events.off(event, handler);
  }

  // Stops the recording and closes the target; a failure of either is the
  // caller's to see, and the target is asked to close even when the
  // recording could not be stopped.
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    const failures: unknown[] = [];
    if (this._screencast)
      await this._screencast.stop().then(undefined, (e) => failures.push(e));
    await this._conn
      .send('Target.closeTarget', { targetId: this._targetId })
      .then(undefined, (e) => failures.push(e));
    if (failures.length)
      throw new AggregateError(
        failures,
        `page ${this._targetId} did not close cleanly`,
      );
  }

  private _frame(): CDPFrame {
    const frame = this._ft.mainFrame;
    if (!frame) throw new CDPError('No main frame');
    return frame;
  }
}
