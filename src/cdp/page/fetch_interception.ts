// The Fetch domain of one page: routes a caller registered for URL patterns,
// and the proxy credentials answered to a proxy's authentication challenge.
// Split out of page.ts, which owns navigation, evaluation and lifecycle.

import { CDPConnection } from '../connection.js';
import { CDPError } from '../errors.js';

// Chrome sends requestId and the request on every Fetch.requestPaused and
// Fetch.authRequired event (https://chromedevtools.github.io/devtools-protocol/tot/Fetch/).
type FetchRequestPausedParams = {
  requestId: string;
  request: { url: string } & Record<string, unknown>;
};

type FetchAuthRequiredParams = {
  requestId: string;
  authChallenge: { source?: string };
};

export class CDPRoute {
  readonly request: Record<string, unknown>;
  private _conn: CDPConnection;
  private _sid: string;
  private _rid: string;
  constructor(
    conn: CDPConnection,
    sid: string,
    params: FetchRequestPausedParams,
  ) {
    this._conn = conn;
    this._sid = sid;
    this.request = params.request;
    this._rid = params.requestId;
  }
  async abort(reason = 'Failed') {
    await this._conn.send(
      'Fetch.failRequest',
      { requestId: this._rid, errorReason: reason },
      this._sid,
    );
  }
  /** Answers the paused request with the response the caller states: its status is required, headers and body as given. */
  async fulfill(o: {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  }) {
    if (!Number.isInteger(o.status)) {
      throw new Error(
        `a fulfilled response needs its HTTP status; got ${JSON.stringify(o.status)}`,
      );
    }
    const headers = o.headers
      ? Object.entries(o.headers).map(([name, value]) => ({ name, value }))
      : [];
    const body = o.body ? Buffer.from(o.body).toString('base64') : '';
    await this._conn.send(
      'Fetch.fulfillRequest',
      {
        requestId: this._rid,
        responseCode: o.status,
        responseHeaders: headers,
        body,
      },
      this._sid,
    );
  }
  async continue_() {
    await this._conn.send(
      'Fetch.continueRequest',
      { requestId: this._rid },
      this._sid,
    );
  }
}

export type RouteHandler = (route: CDPRoute) => Promise<void>;

// A CDP event handler has no caller to hand a rejection to, so the failure is
// said on stderr with the event it came from instead of vanishing.
function reportEventFailure(event: string): (error: unknown) => void {
  return (error) => {
    console.error(
      `[cdp] ${event} handler failed: ${String((error as Error)?.message ?? error)}`,
    );
  };
}

export class FetchInterception {
  private _conn: CDPConnection;
  private _sessionId: string;
  private _routes: Array<{ pattern: RegExp; handler: RouteHandler }> = [];
  private _listenersInstalled = false;
  private _proxyAuth?: { username: string; password: string };
  private _proxyAuthAttempts = new Set<string>();

  constructor(connection: CDPConnection, sessionId: string) {
    this._conn = connection;
    this._sessionId = sessionId;
  }

  async setProxyAuth(credentials: {
    username: string;
    password: string;
  }): Promise<void> {
    if (!credentials.username || !credentials.password) {
      throw new CDPError('Proxy authentication requires non-empty credentials');
    }
    this._proxyAuth = credentials;
    await this._ensureEnabled();
  }

  async route(pattern: string, handler: RouteHandler): Promise<void> {
    await this._ensureEnabled();
    this._routes.push({ pattern: new RegExp(pattern), handler });
  }

  private async _ensureEnabled(): Promise<void> {
    if (!this._listenersInstalled) {
      this._listenersInstalled = true;
      this._conn.on(
        'Fetch.requestPaused',
        (params: FetchRequestPausedParams) => {
          this._onRequestPaused(params).catch(
            reportEventFailure('Fetch.requestPaused'),
          );
        },
        this._sessionId,
      );
      this._conn.on(
        'Fetch.authRequired',
        (params: FetchAuthRequiredParams) => {
          this._onAuthRequired(params).catch(
            reportEventFailure('Fetch.authRequired'),
          );
        },
        this._sessionId,
      );
    }
    await this._conn.send(
      'Fetch.enable',
      {
        patterns: [{ urlPattern: '*' }],
        handleAuthRequests: Boolean(this._proxyAuth),
      },
      this._sessionId,
    );
  }

  private async _onAuthRequired(
    params: FetchAuthRequiredParams,
  ): Promise<void> {
    const requestId = params.requestId;
    const isProxyChallenge = params.authChallenge?.source === 'Proxy';
    if (!requestId || !isProxyChallenge || !this._proxyAuth) {
      await this._conn.send(
        'Fetch.continueWithAuth',
        {
          requestId,
          authChallengeResponse: { response: 'Default' },
        },
        this._sessionId,
      );
      return;
    }
    if (this._proxyAuthAttempts.has(requestId)) {
      await this._conn.send(
        'Fetch.continueWithAuth',
        {
          requestId,
          authChallengeResponse: { response: 'CancelAuth' },
        },
        this._sessionId,
      );
      return;
    }
    this._proxyAuthAttempts.add(requestId);
    await this._conn.send(
      'Fetch.continueWithAuth',
      {
        requestId,
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: this._proxyAuth.username,
          password: this._proxyAuth.password,
        },
      },
      this._sessionId,
    );
  }

  private async _onRequestPaused(
    params: FetchRequestPausedParams,
  ): Promise<void> {
    const url = params.request.url;
    const requestId = params.requestId;
    for (const { pattern, handler } of this._routes) {
      if (pattern.test(url)) {
        await handler(new CDPRoute(this._conn, this._sessionId, params));
        return;
      }
    }
    await this._conn.send(
      'Fetch.continueRequest',
      { requestId },
      this._sessionId,
    );
  }
}
