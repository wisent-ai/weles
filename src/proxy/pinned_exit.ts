/**
 * Whether an account's pinned proxy still opens a tunnel to the platform.
 * An account keeps its one exit: a pin whose proxy refuses the tunnel is not
 * rotated to a fresh session id or replaced by another exit, it ends the
 * session with the proxy's own answer, so the platform never sees the
 * account arrive from an address it was not registered from.
 */
import http from 'node:http';
import https from 'node:https';
import { constants as http2 } from 'node:http2';

import type { ProxyConfig } from './config.js';
import echo from '../trajectories/_shared/network/egress-echo.json';

/**
 * Why the proxy does not open a tunnel to `host` on the HTTPS port, or null
 * when it does: Node's own CONNECT client sends the request, and the proxy's
 * answer (its status line) or the socket's own error is the reason. A proxy
 * with credentials is asked with them; one without, without. No clock
 * decides it.
 */
async function tunnelRefusal(
  cfg: ProxyConfig,
  host: string,
): Promise<string | null> {
  if (!cfg.host || !cfg.port)
    return 'the pin names no proxy host and port to ask';
  const headers: Record<string, string> = {};
  if (cfg.username !== undefined && cfg.password !== undefined) {
    headers['Proxy-Authorization'] =
      `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
  }
  const { promise, resolve } = Promise.withResolvers<string | null>();
  // Node's HTTPS agent carries the protocol's port as `defaultPort`; its
  // type declarations leave the field out, so it is read checked.
  const agent: object = https.globalAgent;
  if (!('defaultPort' in agent) || typeof agent.defaultPort !== 'number') {
    throw new Error(
      "Node's HTTPS agent names no default port, so the tunnel has no port to ask the proxy for",
    );
  }
  const request = http.request({
    host: cfg.host,
    port: Number(cfg.port),
    method: 'CONNECT',
    path: `${host}:${agent.defaultPort}`,
    headers,
  });
  request.once('connect', (answer, socket) => {
    socket.destroy();
    resolve(
      answer.statusCode === http2.HTTP_STATUS_OK
        ? null
        : `proxy_connect_refused: ${answer.statusCode} ${answer.statusMessage}`,
    );
  });
  request.once('error', (error: NodeJS.ErrnoException) => {
    resolve(
      `proxy_connect_failed: ${error.code ? `${error.code} ` : ''}${error.message}`,
    );
  });
  request.end();
  return promise;
}

/**
 * Why the pinned proxy cannot carry the session to `targetHost` (the
 * platform's own host; the declared egress echo's host for a platform that
 * declares none), or null when it opens the tunnel.
 */
export async function pinnedExitRefusal(
  cfg: ProxyConfig,
  targetHost: string | undefined,
): Promise<string | null> {
  if (process.env.PROXY_SKIP_PREFLIGHT === '1') return null;
  return tunnelRefusal(
    cfg,
    targetHost === undefined ? new URL(echo.url).hostname : targetHost,
  );
}
