import { readSetting, writeSetting } from '../state/skarbiec-records.js';

/**
 * Burned-proxy registry stored as one Weles runtime-setting item in Skarbiec.
 *
 * Schema of the JSONB value:
 *   { hosts: { [host: string]: BurnedEntry } }
 *
 * BurnedEntry: { first_burned_at, last_burned_at, ban_count, signals[], platforms[] }
 *
 * resolveAccountSession + resolveProxy call isBurned(host) before handing
 * out a session; the worker pool calls markBurned(host, signal, platform)
 * on hard ban signals.
 */
interface BurnedEntry {
  first_burned_at: string;
  last_burned_at: string;
  ban_count: number;
  signals: string[];
  platforms: string[];
}
interface BurnedValue {
  hosts: Record<string, BurnedEntry>;
}

// Read on every question, never from a copy: a host another process marked
// burned a moment ago is burned now.
async function load(): Promise<BurnedValue> {
  return readSetting<BurnedValue>('burned_proxies', { hosts: {} });
}

async function save(value: BurnedValue): Promise<void> {
  writeSetting('burned_proxies', value);
}

export async function isBurned(
  host: string,
  platform?: string,
): Promise<boolean> {
  if (!host) return false;
  const v = await load();
  const entry = v.hosts[host];
  if (!entry) return false;
  // Per-platform scoping: a host blocked by Instagram isn't necessarily
  // blocked by GitHub — preserve the host for other platforms instead of
  // discarding it from the entire pool. When `platform` is omitted (e.g.
  // legacy callers), keep the previous all-or-nothing behavior.
  if (!platform) return true;
  return entry.platforms.includes(platform);
}

export async function listBurned(): Promise<Record<string, BurnedEntry>> {
  return (await load()).hosts;
}

/**
 * Mark a proxy host as burned. Called by the worker pool on hard ban
 * signals (ip_blocked, captcha_challenge from CDN). Idempotent — increments
 * ban_count and union-s signals/platforms on subsequent calls.
 */
export async function markBurned(
  host: string,
  signal: string,
  platform?: string,
): Promise<void> {
  if (!host || !signal) return;
  const v = await load();
  const now = new Date().toISOString();
  const entry = v.hosts[host];
  if (entry) {
    entry.last_burned_at = now;
    entry.ban_count += 1;
    if (!entry.signals.includes(signal)) entry.signals.push(signal);
    if (platform && !entry.platforms.includes(platform))
      entry.platforms.push(platform);
  } else {
    v.hosts[host] = {
      first_burned_at: now,
      last_burned_at: now,
      ban_count: 1,
      signals: [signal],
      platforms: platform ? [platform] : [],
    };
  }
  await save(v);
  console.log(
    `[burned-proxy] +${host} signal=${signal} ban_count=${v.hosts[host].ban_count}`,
  );
}
