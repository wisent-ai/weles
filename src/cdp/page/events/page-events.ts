import type { CDPConnection } from '../../connection.js';

export type EventHandler = (data?: any) => void;
export type LoadState = 'load' | 'domcontentloaded';

/**
 * The handlers a page's callers registered by event name. Each is also
 * registered on the connection for the page's session, so protocol events of
 * that name reach it, and `fire` hands the page's own events (`load`,
 * `domcontentloaded`, `response`) to the same handlers.
 */
export class PageEvents {
  private conn: CDPConnection;
  private sessionId: string;
  private handlers = new Map<string, EventHandler[]>();

  constructor(conn: CDPConnection, sessionId: string) {
    this.conn = conn;
    this.sessionId = sessionId;
  }

  on(event: string, handler: EventHandler): void {
    const list = this.handlers.get(event);
    if (list) list.push(handler);
    else this.handlers.set(event, [handler]);
    this.conn.on(event, handler, this.sessionId);
  }

  off(event: string, handler: EventHandler): void {
    const list = this.handlers.get(event);
    if (list)
      this.handlers.set(
        event,
        list.filter((h) => h !== handler),
      );
    this.conn.off(event, handler, this.sessionId);
  }

  fire(name: string, data?: any): void {
    const handlers = this.handlers.get(name);
    if (!handlers) return;
    for (const h of handlers) h(data);
  }
}

/**
 * Which load events the page's current document has fired, and who waits
 * for one. A navigation resets what fired; a waiter is released when its
 * event fires, at once when it already has.
 */
export class LoadStates {
  private fired = new Set<LoadState>();
  private waiting = new Map<LoadState, Array<() => void>>();

  /** A navigation began: the next document has fired neither event yet. */
  reset(): void {
    this.fired.clear();
  }

  /** `state` fired: everyone waiting for it is released. */
  fire(state: LoadState): void {
    this.fired.add(state);
    const released = this.waiting.get(state);
    this.waiting.delete(state);
    if (!released) return;
    for (const resolve of released) resolve();
  }

  /** Settles once `state` has fired for the current document. */
  wait(state: LoadState): Promise<void> {
    if (this.fired.has(state)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const waiters = this.waiting.get(state);
    if (waiters) waiters.push(resolve);
    else this.waiting.set(state, [resolve]);
    return promise;
  }
}
