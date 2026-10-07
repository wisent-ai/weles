// The proxy rows the probe samples: which are included (by the provider the
// endpoint derives and the pool type the Skarbiec item declares), how a sticky
// session is built, and the exit each answers.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  rotatingRows,
  stickySession,
} from '../../../../_shared/skarbiec/proxies.mjs';
import { INCLUDE } from './settings.mjs';

export function hash(value) {
  const text = String(value ?? '');
  return text
    ? createHash('sha256').update(text).digest('hex').slice(0, 16)
    : '';
}

export function buildStickyAuth(row, sessId, cc) {
  return stickySession(row, sessId, cc, 'linkedin');
}

export function proxyUrlFor(row, username, password) {
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${row.host}:${row.port}`;
}

// One request through the proxy; curl's own connect and transfer errors are
// the answer when the pool does not deliver, reported with the exit IP blank.
export function sampleExitIp(proxyUrl) {
  try {
    return execFileSync(
      'curl',
      ['-sS', '-x', proxyUrl, 'https://api.ipify.org'],
      {
        encoding: 'utf8',
        maxBuffer: 128 * 1024,
      },
    ).trim();
  } catch (error) {
    console.log(
      `[rotating-probe] proxy_sample_failed: ${String(error.stderr || error.message).trim()}`,
    );
    return '';
  }
}

// The rows the probe samples and the rows it cannot judge because their item
// declares no pool type.
export function fetchRows() {
  return rotatingRows(INCLUDE);
}
