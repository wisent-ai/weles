import os from 'node:os';
import { captureVersions } from '../diagnostics/versions.js';

const SETTING_KEY = 'weles_deployment_version';
const DEFAULT_HEARTBEAT_MS = 60_000;

type FetchLike = typeof fetch;

type EnvLike = Record<string, string | undefined>;

export type DeploymentVersionValue = {
  source: 'weles-worker';
  instance_id: string;
  updated_at: string;
  deployment: {
    weles_pkg_version: unknown;
    weles_commit: unknown;
    weles_commit_short: unknown;
    weles_branch: unknown;
    weles_dirty: unknown;
    weles_dist_sha256: unknown;
    trajectories_tree_sha256: unknown;
    runner_entry_sha256: unknown;
    worker_started_at: unknown;
    recorded_at: unknown;
  };
  runner: {
    worker_host: unknown;
    worker_user: unknown;
    node_version: unknown;
    pid: number;
    platform: NodeJS.Platform;
    arch: string;
  };
};

function envValue(env: EnvLike, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return '';
}

export function deploymentInstanceId(env: EnvLike = process.env): string {
  return env.WELES_INSTANCE_ID?.trim() || env.INSTANCE_ID?.trim() || `weles-${os.hostname() || 'host'}-${process.pid}`;
}

export function buildDeploymentVersionValue(
  versions: Record<string, any> = captureVersions(null),
  now = new Date(),
  instanceId = deploymentInstanceId(),
): DeploymentVersionValue {
  return {
    source: 'weles-worker',
    instance_id: instanceId,
    updated_at: now.toISOString(),
    deployment: {
      weles_pkg_version: versions.weles_pkg_version ?? null,
      weles_commit: versions.weles_commit ?? null,
      weles_commit_short: versions.weles_commit_short ?? null,
      weles_branch: versions.weles_branch ?? null,
      weles_dirty: versions.weles_dirty ?? null,
      weles_dist_sha256: versions.weles_dist_sha256 ?? null,
      trajectories_tree_sha256: versions.trajectories_tree_sha256 ?? null,
      runner_entry_sha256: versions.runner_entry_sha256 ?? null,
      worker_started_at: versions.worker_started_at ?? null,
      recorded_at: versions.recorded_at ?? null,
    },
    runner: {
      worker_host: versions.worker_host ?? null,
      worker_user: versions.worker_user ?? null,
      node_version: versions.node_version ?? process.version,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

export async function writeDeploymentVersion(options: {
  env?: EnvLike;
  fetchImpl?: FetchLike;
  now?: Date;
  versions?: Record<string, any>;
  instanceId?: string;
} = {}): Promise<{ ok: boolean; skipped?: string; error?: string; status?: number; value?: DeploymentVersionValue }> {
  const env = options.env ?? process.env;
  const supabaseUrl = envValue(env, 'CONTENT_PLATFORM_SUPABASE_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = envValue(env, 'CONTENT_PLATFORM_SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseKey) return { ok: false, skipped: 'missing_supabase_config' };

  const value = buildDeploymentVersionValue(options.versions ?? captureVersions(null), options.now ?? new Date(), options.instanceId ?? deploymentInstanceId(env));
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/system_settings?on_conflict=key`;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key: SETTING_KEY, value, updated_at: value.updated_at }),
    });
    if (!response.ok) return { ok: false, status: response.status, error: await response.text().catch(() => response.statusText), value };
    return { ok: true, status: response.status, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), value };
  }
}

export function startDeploymentVersionHeartbeat(options: {
  env?: EnvLike;
  fetchImpl?: FetchLike;
  logger?: Pick<Console, 'log' | 'error'>;
  intervalMs?: number;
} = {}): NodeJS.Timeout | null {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const intervalMs = options.intervalMs ?? Number(env.WELES_DEPLOYMENT_VERSION_HEARTBEAT_MS || DEFAULT_HEARTBEAT_MS);
  const write = async () => {
    const result = await writeDeploymentVersion({ env, fetchImpl: options.fetchImpl });
    if (result.ok) logger.log(`[deployment-version] wrote ${result.value?.deployment.weles_commit_short ?? 'unknown'} instance=${result.value?.instance_id}`);
    else if (result.skipped) logger.log(`[deployment-version] skipped: ${result.skipped}`);
    else logger.error(`[deployment-version] failed: ${result.status ?? ''} ${result.error ?? 'unknown_error'}`.trim());
  };
  void write();
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const timer = setInterval(() => { void write(); }, intervalMs);
  timer.unref?.();
  return timer;
}
