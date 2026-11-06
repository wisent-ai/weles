// What resolving a session writes back to the account record: a proxy or
// persona backfilled onto an older item, and an account retired with its
// pinned pool. An account that was not
// read from Skarbiec has no record to write. A write Skarbiec refuses, or one
// whose record Skarbiec no longer holds, fails the session with the account,
// the change and the cause: a session that went on would act on a record
// Skarbiec does not hold, and the next session would read the old one.

import type { Persona } from '../browser/persona.js';
import type { ProxyConfig } from '../proxy/config.js';
import type { SocialAccount } from '../utils/credentials.js';
import { updateAccount } from '../state/skarbiec-records.js';

type RecordedAccount = SocialAccount & { id: string };

function recorded(acct: SocialAccount): acct is RecordedAccount {
  return typeof acct.id === 'string' && acct.id !== '';
}

function writeAccount(
  acct: RecordedAccount,
  change: string,
  patch: { metadata?: Record<string, any>; active?: boolean },
): void {
  const subject = `account ${acct.id} (${acct.username}): ${change}`;
  let written: boolean;
  try {
    written = updateAccount(acct.id, patch);
  } catch (error) {
    throw new Error(
      `${subject} was not written to Skarbiec: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!written) {
    throw new Error(
      `${subject} was not written: Skarbiec holds no account record ${acct.id}`,
    );
  }
}

export async function backfillProxy(
  acct: SocialAccount,
  cfg: ProxyConfig,
): Promise<void> {
  if (!recorded(acct)) return;
  // A pin is the account's one exit and is never overwritten; a pinned
  // proxy that stops working ends the session (account/pinned_proxy.ts).
  const existingHost = (acct.metadata as any)?.proxy?.host;
  const existingPort = (acct.metadata as any)?.proxy?.port;
  if (
    existingHost &&
    (existingHost !== cfg.host || existingPort !== cfg.port)
  ) {
    console.log(
      `[identity] backfillProxy: preserving registration-time proxy ${existingHost}:${existingPort} (refusing overwrite to ${cfg.host}:${cfg.port})`,
    );
    return;
  }
  const pin = { ...cfg };
  delete pin.username;
  delete pin.password;
  writeAccount(acct, `pinning proxy ${cfg.host}:${cfg.port}`, {
    metadata: { ...acct.metadata, proxy: pin },
  });
}

// Mark an account inactive when its pinned proxy pool retires.
export async function burnAccount(
  acct: SocialAccount,
  reason: string,
): Promise<void> {
  if (!recorded(acct)) return;
  writeAccount(acct, `retiring it (${reason})`, {
    active: false,
    metadata: {
      ...acct.metadata,
      retired_at: new Date().toISOString(),
      retired_reason: reason,
    },
  });
}

export async function backfillPersona(
  acct: SocialAccount,
  persona: Persona,
): Promise<void> {
  if (!recorded(acct)) return;
  writeAccount(acct, 'pinning its persona', {
    metadata: { ...acct.metadata, persona },
  });
}
