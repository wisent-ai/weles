/**
 * Stored sticky-session refresh. resolveAccountSession persists a per-account
 * proxy config in social_accounts.metadata.proxy. Sticky session IDs expire
 * after the provider's TTL, after which CONNECT is refused and Chromium
 * reports ERR_TUNNEL_CONNECTION_FAILED. Pre-flight the stored sticky; if dead,
 * rotate the session id in place keeping host, port and country stable.
 */
import http from 'node:http';
import https from 'node:https';
import { constants as http2 } from 'node:http2';

import type { ProxyConfig } from './config.js';
import echo from '../trajectories/_shared/network/egress-echo.json';

/** How each provider spells the session id inside its credentials. */
const SESSION_PATTERNS: {
  user?: RegExp;
  pass?: RegExp;
  build: (cfg: ProxyConfig, sid: string) => ProxyConfig;
}[] = [
  {
    pass: /_session-\d+/,
    build: (cfg, sid) => ({
      ...cfg,
      password: cfg.password!.replace(/_session-\d+/, `_session-${sid}`),
    }),
  },
  {
    user: /-sessid-\d+/,
    build: (cfg, sid) => ({
      ...cfg,
      username: cfg.username!.replace(/-sessid-\d+/, `-sessid-${sid}`),
    }),
  },
  {
    user: /_s_\d+/,
    build: (cfg, sid) => ({
      ...cfg,
      username: cfg.username!.replace(/_s_\d+/, `_s_${sid}`),
    }),
  },
  {
    user: /-session-\d+/,
    build: (cfg, sid) => ({
      ...cfg,
      username: cfg.username!.replace(/-session-\d+/, `-session-${sid}`),
    }),
  },
];

/**
 * Whether the proxy opens a tunnel to `host` on the HTTPS port: Node's own
 * CONNECT client sends the request, and the proxy's answer (its status line)
 * or the socket's own error ends the check, each said with what it was. A
 * proxy with credentials is asked with them; one without, without. No clock
 * decides it.
 */
async function preflight(cfg: ProxyConfig, host: string): Promise<boolean> {
  if (!cfg.host || !cfg.port) return false;
  const headers: Record<string, string> = {};
  if (cfg.username !== undefined && cfg.password !== undefined) {
    headers['Proxy-Authorization'] =
      `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
  }
  const { promise, resolve } = Promise.withResolvers<boolean>();
  // Node's HTTPS agent carries the protocol's port as `defaultPort`; its
  // type declarations leave the field out, so it is read checked.
  const agent: object = https.globalAgent;
  if (!('defaultPort' in agent) || typeof agent.defaultPort !== 'number') {
    throw new Error(
      "Node's HTTPS agent names no default port, so the tunnel has no port to ask the proxy for",
    );
  }
  const httpsPort = agent.defaultPort;
  const request = http.request({
    host: cfg.host,
    port: Number(cfg.port),
    method: 'CONNECT',
    path: `${host}:${httpsPort}`,
    headers,
  });
  request.once('connect', (answer, socket) => {
    socket.destroy();
    const opened = answer.statusCode === http2.HTTP_STATUS_OK;
    if (!opened)
      console.log(
        `[sticky] proxy_connect_refused on ${cfg.host}: ${answer.statusCode} ${answer.statusMessage}`,
      );
    resolve(opened);
  });
  request.once('error', (error: NodeJS.ErrnoException) => {
    console.log(
      `[sticky] proxy_connect_failed on ${cfg.host}: ${error.code ? `${error.code} ` : ''}${error.message}`,
    );
    resolve(false);
  });
  request.end();
  return promise;
}

/**
 * The same credentials under a fresh session id: the high-resolution clock's
 * reading, which no earlier session of this process had.
 */
function rotate(cfg: ProxyConfig): ProxyConfig | null {
  const sid = process.hrtime.bigint().toString();
  for (const pat of SESSION_PATTERNS) {
    if (pat.user && cfg.username && pat.user.test(cfg.username))
      return pat.build(cfg, sid);
    if (pat.pass && cfg.password && pat.pass.test(cfg.password))
      return pat.build(cfg, sid);
  }
  return null;
}

/**
 * The stored sticky when it still opens a tunnel to `targetHost` (the
 * platform's own host; the declared egress echo's host for a platform that
 * declares none), a rotated one when only its session expired, none when the
 * proxy refuses a fresh session too.
 */
export async function refreshStickyIfDead(
  cfg: ProxyConfig,
  targetHost: string | undefined,
): Promise<ProxyConfig | null> {
  const host = targetHost === undefined ? new URL(echo.url).hostname : targetHost;
  if (process.env.PROXY_SKIP_PREFLIGHT === '1') return cfg;
  if (await preflight(cfg, host)) return cfg;
  // One fresh session id: an expired sticky is the case this repairs; a proxy
  // that refuses a new session too is broken, not expired.
  const rotated = rotate(cfg);
  if (!rotated) {
    console.log(
      `[sticky] no rotatable session pattern for user=${cfg.username}`,
    );
    return null;
  }
  if (await preflight(rotated, host)) {
    console.log(
      `[sticky] rotated dead session on ${cfg.host} -> new sticky working`,
    );
    return rotated;
  }
  console.log(
    `[sticky] proxy_session_rotation_refused on ${cfg.host}: a fresh session id was refused too`,
  );
  return null;
}
