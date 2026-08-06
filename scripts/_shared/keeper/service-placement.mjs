import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WELES_SERVICE = 'com.wisent.always-on.weles';

function stado(arguments_) {
  const binary = process.env.STADO_BIN?.trim() || join(homedir(), '.local', 'bin', 'stado');
  return execFileSync(binary, arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function enforceWelesServicePlacement(entrypoint) {
  let localTarget;
  let rows;
  try {
    localTarget = stado(['registry', 'self', '--name-only']);
    rows = JSON.parse(stado(['service', 'status', WELES_SERVICE, '--json']));
    if (!Array.isArray(rows)) {
      throw new Error('service status did not return an array');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`BLOCKED: ${entrypoint} cannot verify Weles placement through Stado: ${detail}`);
  }

  if (!rows.some((row) => row?.host === localTarget)) {
    throw new Error(
      `BLOCKED: ${entrypoint} is not placed on registry target '${localTarget}'. `
      + `Resolve the active Weles placement with 'stado service resolve ${WELES_SERVICE} --json'.`,
    );
  }
}
