/**
 * What a caller asks WSession for, and how that request is named on disk and
 * in the run log: the option shape every trajectory passes to WSession.start,
 * the redaction used when the request is logged, the country hint read out of
 * a pool-style proxy request, and the per-account browser-profile directory
 * the request resolves to.
 *
 * Extracted verbatim from wsession.ts (WSessionOptions, redactProxyForLog,
 * countryHintFromProxyRequest, WSession.automaticUserDataDir) so the class
 * file stays under its 300-line cap. WSessionOptions is re-exported by name
 * from ../wsession.ts, so its import path is unchanged for every consumer.
 */

import { mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import type { AsyncNewBrowserOptions } from '../../async_api.js';
import type { Persona } from '../../browser/persona.js';

/** The realized proxy a launched session presents, as async_api takes it. */
export type SessionProxy = NonNullable<AsyncNewBrowserOptions['proxy']>;

export interface WSessionOptions {
  label?: string;
  proxy?: string;
  chromiumPath?: string;
  userDataDir?: string;
  headless?: boolean;
  record?: boolean;
  operatorCdp?: boolean;
  targetHost?: string;
  os?: string;
  locale?: string;
  persona?: Persona;
  browser?: string;
  pageDiagnostics?: boolean;
  userAgent?: string;
  // When set, WSession.start auto-invokes generateIdentity(platform) and
  // attaches the result to ws.identity. Register trajectories should pass
  // their platform here instead of importing generateIdentity themselves.
  platform?: string;
}

export function redactProxyForLog(proxy: unknown): string {
  if (!proxy) return 'undefined';
  if (typeof proxy === 'string') {
    try {
      const u = new URL(proxy);
      if (u.username) u.username = `${decodeURIComponent(u.username).slice(0, 18)}...`;
      if (u.password) u.password = '***';
      return u.toString();
    } catch {
      return '[proxy]';
    }
  }
  if (typeof proxy === 'object') {
    const p = proxy as { server?: string; username?: string; password?: string };
    return JSON.stringify({
      server: p.server,
      username: p.username ? `${p.username.slice(0, 18)}...` : undefined,
      password: p.password ? '***' : undefined,
    });
  }
  return String(proxy);
}

export function countryHintFromProxyRequest(proxy: unknown): string | undefined {
  if (typeof proxy !== 'string' || proxy.startsWith('http') || proxy.startsWith('socks')) return undefined;
  const countryTokens = new Set(['us', 'uk', 'gb', 'br', 'de', 'fr', 'nl', 'ca', 'au']);
  const tokens = proxy.toLowerCase().match(/\b[a-z]{2}\b/g) ?? [];
  const cc = tokens.find(t => countryTokens.has(t));
  return cc?.toUpperCase();
}

/**
 * The browser profile directory this request owns: one directory per account,
 * keyed by a hash of ACCOUNT_ID under <platform>/<browser>. Undefined when the
 * run has no ACCOUNT_ID, which is how a session gets an ephemeral profile.
 */
export function accountProfileDirectory(opts: WSessionOptions, browser: string): string | undefined {
  const accountId = process.env.ACCOUNT_ID?.trim();
  if (!accountId) return undefined;
  const action = process.env.ACTION?.trim() ?? '';
  const inferredPlatform = opts.platform?.trim()
    || action.split('_').at(Number(false))?.trim()
    || opts.targetHost?.trim()
    || 'unknown';
  const safePlatform = inferredPlatform.toLowerCase().replace(/[^\w.-]+/g, '-');
  const safeBrowser = browser.toLowerCase().replace(/[^\w.-]+/g, '-');
  const accountKey = createHash('sha256').update(accountId).digest('hex');
  const root = process.env.WELES_BROWSER_PROFILE_ROOT?.trim()
    || join(userInfo().homedir, '.local', 'state', 'weles', 'browser-profiles');
  const parent = join(root, safePlatform, safeBrowser);
  const directory = join(parent, accountKey);
  const ownerOnly = Number.parseInt('700', Number('8'));
  mkdirSync(parent, { recursive: true, mode: ownerOnly });
  if (process.env.WELES_FRESH_PROFILE === '1') {
    try {
      mkdirSync(directory, { mode: ownerOnly });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('fresh browser profile directory already exists');
      }
      throw error;
    }
  } else {
    mkdirSync(directory, { recursive: true, mode: ownerOnly });
  }
  chmodSync(directory, ownerOnly);
  return directory;
}
