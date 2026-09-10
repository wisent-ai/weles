// What a proxy resolution leaves behind: one attempt record per candidate
// exit it weighed, hashed where the value would identify a session, and
// the platform the target host maps to for the policy checks.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../session/run-recordings.js';

export type ProxyPreflightAttempt = {
  provider?: string;
  display_name: string;
  proxy_type: string;
  country: string;
  endpoint: { host: string; port: string };
  sticky_hash: string;
  connect_status?: number;
  exit_ip_hash?: string;
  exit_ip_present?: boolean;
  geo_result?: string;
  geo_exit_cc?: string;
  linkedin_probe_result?: string;
  linkedin_probe_bytes?: number;
  linkedin_probe_request?: unknown;
  linkedin_probe_transport?: unknown;
  linkedin_probe_body_markers?: unknown;
  linkedin_probe_response_body?: unknown;
  linkedin_probe_error?: string;
  tiktok_route_result?: string;
  tiktok_vregion_present?: boolean;
  rejected_reason?: string;
};

export function diagHash(value: unknown): string | undefined {
  const text = String(value ?? '');
  if (!text) return undefined;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function proxyPreflightDir(): string | undefined {
  const label = process.env.WELES_PROXY_DIAGNOSTICS_LABEL || process.env.WELES_LABEL;
  if (!label) return undefined;
  const dir = runRecordingsDir(label); // G17: recordings/<run_uuid>/<label>/proxy_preflight.json
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeProxyPreflightDiagnostics(diag: Record<string, unknown>): void {
  try {
    const dir = proxyPreflightDir();
    if (!dir) return;
    writeFileSync(join(dir, 'proxy_preflight.json'), JSON.stringify({
      ...diag,
      redaction: {
        proxy_credentials: 'omitted',
        sticky_ids: 'sha256-prefix only',
        exit_ips: 'sha256-prefix only',
        linkedin_probe: 'request headers, curl transport metadata, and unauthenticated response bodies captured; proxy credentials omitted',
      },
    }, null, 2));
  } catch {}
}

export function platformFromTarget(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const h = host.toLowerCase();
  if (h.includes('instagram.com') || h.includes('threads.net')) return 'instagram';
  if (h.includes('x.com') || h.includes('twitter.com')) return 'twitter';
  if (h.includes('linkedin.com')) return 'linkedin';
  if (h.includes('reddit.com')) return 'reddit';
  if (h.includes('discord.com') || h.includes('discordapp.com')) return 'discord';
  if (h.includes('github.com')) return 'github';
  if (h.includes('tiktok.com')) return 'tiktok';
  if (h.includes('producthunt.com')) return 'producthunt';
  if (h.includes('youtube.com')) return 'youtube';
  if (h.includes('google.com')) return 'google';  // accounts.google.com etc — was undefined → legacy isBurned blocked all PacketStream LB IPs (verified 2026-05-07)
  return undefined;
}
