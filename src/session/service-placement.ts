import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WELES_SERVICE = 'com.wisent.always-on.weles';

type ServiceStatusRow = {
  host?: unknown;
};

function stado(arguments_: string[]): string {
  const binary = process.env.STADO_BIN?.trim() || join(homedir(), '.local', 'bin', 'stado');
  const environment = {
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
