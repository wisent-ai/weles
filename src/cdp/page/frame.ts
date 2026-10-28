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

  get url(): string {
    return this._url;
  }
  set url(v: string) {
    this._url = v;
  }

  get name(): string {
    return this._name;
  }
  set name(v: string) {
    this._name = v;
  }

  get parentFrame(): CDPFrame | null {
    return this._parentFrame;
  }

  invalidateContext(): void {
    this._isolatedContextId = null;
  }

  private async _ensureIsolatedWorld(): Promise<number> {
    if (this._isolatedContextId !== null) return this._isolatedContextId;
    const result = await this._conn.send(
      'Page.createIsolatedWorld',
      {
        frameId: this.frameId,
        worldName: '',
        grantUniveralAccess: true,
      },
      this._sessionId,
    );
    this._isolatedContextId = result.executionContextId;
    return this._isolatedContextId!;
  }

  async evaluate(expression: string, arg?: any): Promise<any> {
    const contextId = await this._ensureIsolatedWorld();
    const result = await this._conn.send(
      'Runtime.evaluate',
      {
        expression: wrapExpression(expression, arg),
        contextId,
        returnByValue: true,
        awaitPromise: true,
      },
      this._sessionId,
    );
    return extractValue(result);
  }

  async evaluateMain(expression: string, arg?: any): Promise<any> {
    const result = await this._conn.send(
      'Runtime.evaluate',
      {
        expression: wrapExpression(expression, arg),
        returnByValue: true,
        awaitPromise: true,
      },
      this._sessionId,
    );
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

  get mainFrame(): CDPFrame | null {
    return this._mainFrame;
  }

  get frames(): CDPFrame[] {
    return [...this._frames.values()];
  }

  get(frameId: string): CDPFrame | undefined {
    return this._frames.get(frameId);
  }

  setMainFrame(frameId: string, url = ''): CDPFrame {
    const frame = new CDPFrame(frameId, this._conn, this._sessionId, url);
    this._frames.set(frameId, frame);
    this._mainFrame = frame;
    return frame;
  }

  // Each event's fields as the DevTools protocol states them
  // (https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-frameAttached
  // and #event-frameNavigated). An event missing a field the protocol
  // requires is thrown naming it, which breaks the connection with that
  // error, rather than filed under an empty frame id.
  private _setupListeners(): void {
    this._conn.on(
      'Page.frameAttached',
      (params: any) => {
        const event = 'Page.frameAttached';
        const frameId = required(params, 'frameId', event);
        const parentId = required(params, 'parentFrameId', event);
        // A parent attached before this tree listened is not known to it.
        const known = this._frames.get(parentId);
        const parent = known === undefined ? null : known;
        this._frames.set(
          frameId,
          new CDPFrame(frameId, this._conn, this._sessionId, '', '', parent),
        );
      },
      this._sessionId,
    );

    this._conn.on(
      'Page.frameNavigated',
      (params: any) => {
        const event = 'Page.frameNavigated';
        const info = params?.frame;
        if (info === null || typeof info !== 'object')
          throw new CDPError(
            `the DevTools event ${event} carries no frame: ${JSON.stringify(params)}`,
          );
        const frameId = required(info, 'id', `${event} frame`);
        const url = required(info, 'url', `${event} frame`);
        let frame = this._frames.get(frameId);
        if (!frame) {
          frame = new CDPFrame(frameId, this._conn, this._sessionId, url);
          this._frames.set(frameId, frame);
          if (!this._mainFrame) this._mainFrame = frame;
        } else {
          frame.url = url;
          frame.invalidateContext();
        }
        // The protocol leaves the name out for a frame that has none.
        if (typeof info.name === 'string') frame.name = info.name;
      },
      this._sessionId,
    );

    this._conn.on(
      'Page.frameDetached',
      (params: any) => {
        this._frames.delete(
          required(params, 'frameId', 'Page.frameDetached'),
        );
      },
      this._sessionId,
    );
  }
}

/** The text field `field` a DevTools event requires, or the error naming it. */
function required(params: any, field: string, event: string): string {
  const value = params?.[field];
  if (typeof value !== 'string')
    throw new CDPError(
      `the DevTools event ${event} carries no ${field}: ${JSON.stringify(params)}`,
    );
  return value;
}

/**
 * Whether `s`, which opens with `(`, closes that parenthesis before its last
 * character: a complete call such as `(() => {...})()` rather than one
 * parenthesised function. The open parentheses are kept as a stack, so the
 * first one closes when the stack empties.
 */
function closesBeforeEnd(s: string): boolean {
  const open: string[] = [];
  for (const [at, char] of s.split('').entries()) {
    if (char === '(') open.push(char);
    else if (char === ')') {
      open.pop();
      if (!open.length) return s.slice(at) !== ')';
    }
  }
  return false;
}

export function wrapExpression(expression: string, arg?: any): string {
  const s = expression.trim();
  // Already a complete IIFE like (() => {...})() or (function(){...})() — return as-is
  if (s.startsWith('(') && s.endsWith(')') && closesBeforeEnd(s)) return s;
  if (
    s.startsWith('(') ||
    s.startsWith('function') ||
    s.startsWith('async') ||
    s.includes('=>')
  ) {
    const serialized = arg !== undefined ? JSON.stringify(arg) : '';
    return `(${s})(${serialized})`;
  }
  return s;
}

/** The first of `said` that is non-empty text. */
function firstText(said: unknown[]): string | undefined {
  return said.find(
    (text): text is string => typeof text === 'string' && text !== '',
  );
}

/**
 * The value a Runtime.evaluate or Runtime.callFunctionOn answer carries
 * (https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate).
 * An error result or an exception is thrown with what the page said, and
 * with the whole answer when it said no text, never as an empty message; an
 * answer with no result, which the protocol does not allow, is thrown
 * quoting it rather than read as an undefined value.
 */
export function extractValue(result: any): any {
  const remote = result?.result;
  if (remote === undefined)
    throw new CDPError(
      `page evaluation answered no result: ${JSON.stringify(result)}`,
    );
  if (remote.subtype === 'error') {
    const text = firstText([remote.description, remote.value]);
    throw new CDPError(
      text === undefined
        ? `page evaluation answered an error object: ${JSON.stringify(remote)}`
        : text,
    );
  }
  const exception = result.exceptionDetails;
  if (exception) {
    const thrown = exception.exception;
    const text = firstText([
      thrown?.description,
      thrown?.value,
      exception.text,
    ]);
    throw new CDPError(
      text === undefined
        ? `page evaluation threw without saying what: ${JSON.stringify(exception)}`
        : text,
    );
  }
  return remote.value;
}
