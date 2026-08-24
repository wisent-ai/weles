import os from 'node:os';
import { captureVersions } from '../diagnostics/versions.js';
import { writeSetting } from '../state/skarbiec-records.js';

const PRODUCTION_SETTING_KEY = 'weles_deployment_version';
const DEFAULT_HEARTBEAT_MS = 60_000;

type FetchLike = typeof fetch;

type EnvLike = Record<string, string | undefined>;

export type ImmutableReleaseIdentity = {
  schema: 'weles.release-identity.v1';
  worker_version: string;
  source_revision: string;
  artifact_sha256: string;
  deployment_manifest_sha256: string;
  deployment_id: string;
  ring: 'candidate' | 'development' | 'canary' | 'production';
  claims_enabled: boolean;
  chromium_release: string;
  chromium_sha256: string;
  firefox_release: string;
  firefox_sha256: string;
  database_schema_version: number;
  api_schemas: string[];
};

export type DeploymentVersionValue = {
  source: 'weles-worker';
  instance_id: string;
  updated_at: string;
  release?: ImmutableReleaseIdentity;
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

function immutableReleaseIdentity(env: EnvLike): ImmutableReleaseIdentity | undefined {
  const workerVersion = envValue(env, 'WELES_WORKER_VERSION');
  const sourceRevision = envValue(env, 'WELES_SOURCE_REVISION');
  const artifactSha256 = envValue(env, 'WELES_WORKER_ARTIFACT_SHA256');
  const manifestSha256 = envValue(env, 'WELES_DEPLOYMENT_MANIFEST_SHA256');
  const deploymentId = envValue(env, 'WELES_DEPLOYMENT_ID');
  const ring = envValue(env, 'WELES_DEPLOYMENT_RING');
  const claimsEnabled = envValue(env, 'WELES_CLAIMS_ENABLED');
  const chromiumRelease = envValue(env, 'WELES_CHROMIUM_RELEASE');
  const chromiumSha256 = envValue(env, 'WELES_CHROMIUM_SHA256');
  const firefoxRelease = envValue(env, 'WELES_FIREFOX_RELEASE');
  const firefoxSha256 = envValue(env, 'WELES_FIREFOX_SHA256');
  const databaseSchema = envValue(env, 'WELES_DATABASE_SCHEMA_VERSION');
  const apiSchemas = envValue(env, 'WELES_API_SCHEMAS');
  const values = [
    workerVersion,
    sourceRevision,
    artifactSha256,
    manifestSha256,
    deploymentId,
    ring,
    claimsEnabled,
    chromiumRelease,
    chromiumSha256,
    firefoxRelease,
    firefoxSha256,
    databaseSchema,
    apiSchemas,
  ];
  if (values.every((value) => !value)) return undefined;
  if (values.some((value) => !value)) {
    throw new Error('immutable release identity is partially configured');
  }
  const databaseSchemaVersion = Number(databaseSchema);
  if (!Number.isInteger(databaseSchemaVersion) || databaseSchemaVersion < 1) {
    throw new Error('WELES_DATABASE_SCHEMA_VERSION must be a positive integer');
  }
  if (!['candidate', 'development', 'canary', 'production'].includes(ring)) {
    throw new Error('WELES_DEPLOYMENT_RING must name a release ring');
  }
  if (!['0', '1'].includes(claimsEnabled)) throw new Error('WELES_CLAIMS_ENABLED must be 0 or 1');
  if ((ring === 'production') !== (claimsEnabled === '1')) {
    throw new Error('only the production release ring may claim queued work');
  }
  return {
    schema: 'weles.release-identity.v1',
    worker_version: workerVersion,
    source_revision: sourceRevision,
    artifact_sha256: artifactSha256,
    deployment_manifest_sha256: manifestSha256,
    deployment_id: deploymentId,
    ring: ring as ImmutableReleaseIdentity['ring'],
    claims_enabled: claimsEnabled === '1',
    chromium_release: chromiumRelease,
    chromium_sha256: chromiumSha256,
    firefox_release: firefoxRelease,
    firefox_sha256: firefoxSha256,
    database_schema_version: databaseSchemaVersion,
    api_schemas: apiSchemas.split(',').map((value) => value.trim()).filter(Boolean),
  };
}

export function deploymentInstanceId(env: EnvLike = process.env): string {
  return env.WELES_INSTANCE_ID?.trim() || env.INSTANCE_ID?.trim() || `weles-${os.hostname() || 'host'}-${process.pid}`;
}

export function buildDeploymentVersionValue(
  versions: Record<string, any> = captureVersions(null),
  now = new Date(),
  instanceId = deploymentInstanceId(),
  env: EnvLike = process.env,
): DeploymentVersionValue {
  const release = immutableReleaseIdentity(env);
  return {
    source: 'weles-worker',
    instance_id: instanceId,
    updated_at: now.toISOString(),
    ...(release ? { release } : {}),
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
} = {}): Promise<{ ok: boolean; error?: string; value?: DeploymentVersionValue }> {
  const env = options.env ?? process.env;
  const instanceId = options.instanceId ?? deploymentInstanceId(env);
  const ring = envValue(env, 'WELES_DEPLOYMENT_RING') || 'production';
  const settingKey = ring === 'production' ? PRODUCTION_SETTING_KEY : `${PRODUCTION_SETTING_KEY}_${ring}_${instanceId}`;
  const value = buildDeploymentVersionValue(options.versions ?? captureVersions(null), options.now ?? new Date(), instanceId, env);
  try {
    writeSetting(settingKey, value);
    return { ok: true, value };
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
    if (result.ok) logger.log(`[deployment-version] wrote ${result.value?.release?.source_revision.slice(0, 8) ?? result.value?.deployment.weles_commit_short ?? 'unknown'} instance=${result.value?.instance_id}`);
    else logger.error(`[deployment-version] failed: ${result.error ?? 'unknown_error'}`);
  };
  void write();
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const timer = setInterval(() => { void write(); }, intervalMs);
  timer.unref?.();
  return timer;
}
