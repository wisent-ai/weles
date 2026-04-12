import WebSocket from 'ws';
import { CDPError, CDPTargetClosedError } from './errors';

interface PendingCommand {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

type EventCallback = (params: any) => void;

export class CDPConnection {
  private _ws: WebSocket | null = null;
  private _nextId = 1;
  private _pending = new Map<number, PendingCommand>();
  private _listeners = new Map<string, Set<EventCallback>>();
  private _closed = false;

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });

      ws.on('open', () => {
        this._ws = ws;
        this._closed = false;
        resolve();
      });

      ws.on('message', (data: WebSocket.Data) => {
        this._onMessage(data);
      });

      ws.on('close', () => {
        this._closed = true;
        this._rejectAllPending(new CDPTargetClosedError());
      });

      ws.on('error', (err: Error) => {
        if (!this._ws) {
          reject(err);
        }
      });
    });
  }

  send(method: string, params?: Record<string, any>, sessionId?: string): Promise<any> {
    if (this._closed || !this._ws) {
      return Promise.reject(new CDPTargetClosedError());
    }

    const id = this._nextId++;
    const msg: Record<string, any> = { id, method };
    if (params) msg.params = params;
    if (sessionId) msg.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._ws!.send(JSON.stringify(msg), (err) => {
        if (err) {
          this._pending.delete(id);
          reject(err);
        }
      });
    });
  }

  on(event: string, callback: EventCallback, sessionId?: string): void {
    const key = sessionId ? `${sessionId}:${event}` : event;
    let set = this._listeners.get(key);
    if (!set) {
      set = new Set();
      this._listeners.set(key, set);
    }
    set.add(callback);
  }

  off(event: string, callback: EventCallback, sessionId?: string): void {
    const key = sessionId ? `${sessionId}:${event}` : event;
    this._listeners.get(key)?.delete(callback);
  }

  async close(): Promise<void> {
    if (!this._ws) return;
    this._closed = true;
    this._rejectAllPending(new CDPTargetClosedError());
    return new Promise((resolve) => {
      this._ws!.once('close', () => resolve());
      this._ws!.close();
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  private _onMessage(data: WebSocket.Data): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      const pending = this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new CDPError(`${msg.error.message} (${msg.error.code})`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method) {
      const sessionId = msg.params?.sessionId ?? msg.sessionId;
      const params = msg.params ?? {};

      if (sessionId) {
        this._fireEvent(`${sessionId}:${msg.method}`, params);
      }
      this._fireEvent(msg.method, params);
    }
  }

  private _fireEvent(key: string, params: any): void {
    const set = this._listeners.get(key);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(params);
      } catch {
        // listener errors are silently dropped
      }
    }
  }

  private _rejectAllPending(error: Error): void {
    for (const pending of this._pending.values()) {
      pending.reject(error);
    }
    this._pending.clear();
  }
}
