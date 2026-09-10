// What resolving a session writes back to the account record: a dead proxy
// cleared with its failover noted, a proxy or persona backfilled onto an older
// item, and an account retired with its pinned pool. Each write is best-effort
// and says so on stderr; the session itself is already decided by then.

import type { Persona } from '../browser/persona.js';
import type { ProxyConfig } from '../proxy/config.js';
import type { SocialAccount } from '../utils/credentials.js';
import { updateAccount } from '../state/skarbiec-records.js';

export async function clearDeadProxy(acct: SocialAccount, reason: string): Promise<void> {
  const metadata = { ...((acct.metadata ?? {}) as Record<string, any>) };
  const previous = metadata.proxy as Partial<ProxyConfig> | undefined;
  delete metadata.proxy;
  metadata.proxy_failover = {
    at: new Date().toISOString(),
    reason,
    previous: previous ? {
      host: previous.host,
      port: previous.port,
      provider: previous.provider,
      proxy_type: previous.proxy_type,
    } : null,
  };
  (acct as any).metadata = metadata;

  if (!acct.id) return;
  try {
    updateAccount(acct.id, { metadata });
  } catch (e) {
    console.error('[identity] clearDeadProxy failed:', (e as Error).message);
  }
}

export async function backfillProxy(acct: SocialAccount, cfg: ProxyConfig): Promise<void> {
  if (!acct.id) return;
  // Registration-time endpoints stay pinned until an authenticated CONNECT
  // preflight proves the route is dead and clearDeadProxy records the failover.
  const existingHost = (acct.metadata as any)?.proxy?.host;
  const existingPort = (acct.metadata as any)?.proxy?.port;
  if (existingHost && (existingHost !== cfg.host || existingPort !== cfg.port)) {
    console.log(`[identity] backfillProxy: preserving registration-time proxy ${existingHost}:${existingPort} (refusing overwrite to ${cfg.host}:${cfg.port})`);
    return;
  }
  const pin = { ...cfg };
  delete pin.username;
  delete pin.password;
  const merged = { ...(acct.metadata ?? {}), proxy: pin };
  try {
    updateAccount(acct.id, { metadata: merged });
  } catch (e) {
    console.error('[identity] backfillProxy failed:', (e as Error).message);
  }
}

// Mark an account inactive when its pinned proxy pool retires.
export async function burnAccount(acct: SocialAccount, reason: string): Promise<void> {
  if (!acct.id) return;
  const meta = (acct.metadata ?? {}) as Record<string, unknown>;
  const merged = {
    ...meta,
    retired_at: new Date().toISOString(),
    retired_reason: reason,
  };
  try {
    updateAccount(acct.id, { active: false, metadata: merged });
  } catch (e) {
    console.error('[identity] burnAccount failed:', (e as Error).message);
  }
}

export async function backfillPersona(acct: SocialAccount, persona: Persona): Promise<void> {
  if (!acct.id) return;
  const merged = { ...((acct.metadata ?? {}) as any), persona };
  try {
    updateAccount(acct.id, { metadata: merged });
  } catch (e) {
    console.error('[identity] backfillPersona failed:', (e as Error).message);
  }
}
