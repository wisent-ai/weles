import os from 'node:os';

/** Normalize configured and OS host names without changing their DNS identity. */
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

/** The host used for product-owned placement. INSTANCE_ID never affects routing. */
export const HOSTNAME = normalizeHostname(os.hostname());

/** Stable claim/watchdog identity, preserving the worker's existing semantics. */
export const INSTANCE_ID = process.env.INSTANCE_ID ?? `weles-${os.hostname() || 'unknown'}-${process.pid}`;
