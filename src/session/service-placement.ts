import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WELES_SERVICE = 'com.wisent.always-on.weles';

type ServiceStatusRow = {
  host?: unknown;
};

// Stado lives under `.stado/bin` on the fleet's Macs and under `.local/bin` on
// hosts that installed it the other way, so one hard-coded default is wrong on
// part of the estate. The always-on mini has no `.local/bin/stado` at all, and
// the failure that produced read as "cannot verify Weles placement through
// Stado: spawnSync ENOENT" — which sounds like the registry is unreachable
// rather than like a path is wrong, and stops every browser trajectory on the
// one host they are supposed to run on. `src/auth/apple-account-placement`
// already resolved this; the guard every session goes through did not.
// STADO_BIN still wins, for a host that keeps it somewhere else again.
function stadoBinary(): string {
  const configured = process.env.STADO_BIN?.trim();
  if (configured) return configured;
  const home = process.env.HOME ?? homedir();
  for (const candidate of [
    join(home, '.stado', 'bin', 'stado'),
    join(home, '.local', 'bin', 'stado'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('no Stado binary on this host; set STADO_BIN');
}

function stado(arguments_: string[]): string {
  const binary = stadoBinary();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    STADO_CONFIG: join(homedir(), '.stado', 'local-placement-config.absent'),
    WC_STORAGE_BACKEND: 'local',
    WC_LOCAL_STORAGE_PATH: join(homedir(), '.stado', 'local-storage'),
  };
  delete environment.STADO_API_TOKEN;
  delete environment.STADO_API_URL;
  return execFileSync(binary, arguments_, {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Permit local browser execution only on a registry host that currently owns
 * the Weles service declaration. Endpoint consumers use `service resolve`;
 * this placement check deliberately does not require the service's own beacon
 * to be active while the process is starting.
 */
export function enforceWelesServicePlacement(entrypoint: string): void {
  let localTarget: string;
  let rows: ServiceStatusRow[];
  try {
    localTarget = stado(['registry', 'self', '--name-only']);
    const parsed: unknown = JSON.parse(
      stado(['service', 'status', WELES_SERVICE, '--json']),
    );
    if (!Array.isArray(parsed)) {
      throw new Error('service status did not return an array');
    }
    rows = parsed as ServiceStatusRow[];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BLOCKED: ${entrypoint} cannot verify Weles placement through Stado: ${detail}`,
    );
  }

  if (!rows.some((row) => row.host === localTarget)) {
    throw new Error(
      `BLOCKED: ${entrypoint} is not placed on registry target '${localTarget}'. `
      + `Resolve the active Weles placement with 'stado service resolve ${WELES_SERVICE} --json'.`,
    );
  }
}
