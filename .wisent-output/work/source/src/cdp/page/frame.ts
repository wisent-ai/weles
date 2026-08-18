import { CDPConnection } from '../connection.js';
import { CDPError } from '../errors.js';

export class CDPFrame {
  readonly frameId: string;
  private _conn: CDPConnection;
  private _sessionId: string;
  private _url: string;
  private _name: string;
  private _parentFrame: CDPFrame | null;
  private _isolatedContextId: number | null = null;

  constructor(
    frameId: string,
    connection: CDPConnection,
    sessionId: string,
    url = '',
    name = '',
    parentFrame: CDPFrame | null = null,
  ) {
    this.frameId = frameId;
    this._conn = connection;
    this._sessionId = sessionId;
    this._url = url;
    this._name = name;
    this._parentFrame = parentFrame;
  }

  get url(): string { return this._url; }
  set url(v: string) { this._url = v; }

  get name(): string { return this._name; }
  set name(v: string) { this._name = v; }

  get parentFrame(): CDPFrame | null { return this._parentFrame; }

  invalidateContext(): void {
    this._isolatedContextId = null;
  }

  private async _ensureIsolatedWorld(): Promise<number> {
    if (this._isolatedContextId !== null) return this._isolatedContextId;
    const result = await this._conn.send('Page.createIsolatedWorld', {
      frameId: this.frameId,
      worldName: '',
      grantUniveralAccess: true,
    }, this._sessionId);
    this._isolatedContextId = result.executionContextId;
    return this._isolatedContextId!;
  }

  async evaluate(expression: string, arg?: any): Promise<any> {
    const contextId = await this._ensureIsolatedWorld();
    const result = await this._conn.send('Runtime.evaluate', {
      expression: wrapExpression(expression, arg),
      contextId,
      returnByValue: true,
      awaitPromise: true,
    }, this._sessionId);
    return extractValue(result);
  }

  async evaluateMain(expression: string, arg?: any): Promise<any> {
    const result = await this._conn.send('Runtime.evaluate', {
      expression: wrapExpression(expression, arg),
      returnByValue: true,
      awaitPromise: true,
    }, this._sessionId);
    return extractValue(result);
  }

  locator(selector: string): any {
    // Lazy require to avoid circular dependency with locator module
    const { CDPLocator } = require('../dom/locator.js');
    return new CDPLocator(this, selector);
  }
}

export class FrameTree {
  private _conn: CDPConnection;
  private _sessionId: string;
  private _frames = new Map<string, CDPFrame>();
  private _mainFrame: CDPFrame | null = null;

  constructor(connection: CDPConnection, sessionId: string) {
    this._conn = connection;
    this._sessionId = sessionId;
    this._setupListeners();
  }

  get mainFrame(): CDPFrame | null { return this._mainFrame; }

  get frames(): CDPFrame[] { return [...this._frames.values()]; }

  get(frameId: string): CDPFrame | undefined {
    return this._frames.get(frameId);
  }

  setMainFrame(frameId: string, url = ''): CDPFrame {
    const frame = new CDPFrame(frameId, this._conn, this._sessionId, url);
    this._frames.set(frameId, frame);
    this._mainFrame = frame;
    return frame;
  }

  private _setupListeners(): void {
    this._conn.on('Page.frameAttached', (params: any) => {
      const frameId: string = params.frameId;
      const parentId: string = params.parentFrameId ?? '';
      const parent = this._frames.get(parentId) ?? null;
      this._frames.set(frameId,
        new CDPFrame(frameId, this._conn, this._sessionId, '', '', parent));
    }, this._sessionId);

    this._conn.on('Page.frameNavigated', (params: any) => {
      const info = params.frame ?? {};
      const frameId: string = info.id ?? '';
      let frame = this._frames.get(frameId);
      if (!frame) {
        frame = new CDPFrame(
          frameId, this._conn, this._sessionId,
          info.url ?? '', info.name ?? '',
        );
        this._frames.set(frameId, frame);
        if (!this._mainFrame) this._mainFrame = frame;
      } else {
        frame.url = info.url ?? frame.url;
        frame.name = info.name ?? frame.name;
        frame.invalidateContext();
      }
    }, this._sessionId);

    this._conn.on('Page.frameDetached', (params: any) => {
      this._frames.delete(params.frameId);
    }, this._sessionId);
  }
}

export function wrapExpression(expression: string, arg?: any): string {
  const s = expression.trim();
  // Already a complete IIFE like (() => {...})() or (function(){...})() — return as-is
  if (s.startsWith('(') && s.endsWith(')')) {
    const inner = s.slice(1);
    let depth = 1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '(') depth++;
      else if (inner[i] === ')') { depth--; if (depth === 0 && i < inner.length - 1) return s; }
    }
  }
  if (s.startsWith('(') || s.startsWith('function') || s.startsWith('async') || s.includes('=>')) {
    const serialized = arg !== undefined ? JSON.stringify(arg) : '';
    return `(${s})(${serialized})`;
  }
  return s;
}

export function extractValue(result: any): any {
  const r = result?.result ?? {};
  if (r.subtype === 'error') {
    throw new CDPError(r.description ?? r.value ?? 'Evaluation error');
  }
  const exception = result?.exceptionDetails;
  if (exception) {
    const exObj = exception.exception ?? {};
    throw new CDPError(exObj.description ?? exObj.value ?? exception.text ?? '');
  }
  return r.value;
}
