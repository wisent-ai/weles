import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WELES_SERVICE = 'com.wisent.always-on.weles';

// Stado lives under `.stado/bin` on the fleet's Macs and under `.local/bin` on
// hosts that installed it the other way. STADO_BIN still wins.
function stadoBinary() {
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

function stado(arguments_) {
  const binary = stadoBinary();
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
