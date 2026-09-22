#!/usr/bin/env node
/**
 * The Weles API's own startup. This is the program the managed unit runs.
 *
 * It used to be a 245-line shell wrapper under a `scripts/` folder, which meant
 * the service's startup contract — which env files it reads, which Skarbiec
 * fields it must hold before it serves, which port decides who is live — lived
 * in a file nobody compiled and everybody could run by hand. It is product
 * code, so it lives here and imports the HTTP API into this Node process after
 * acquiring its startup credentials. The API owns its listener and drains its
 * tasks on shutdown. Startup inspects the shared Skarbiec broker; subsequent
 * credential operations report their actual dependency failures.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { ENV_FILES, PATH_PREFIX, loadEnvFile } from './weles-api-launcher/configuration.mjs';
import { holderHealth, portHolder } from './weles-api-launcher/port.mjs';
import { refuse } from './weles-api-launcher/running.mjs';
import { startup } from './weles-api-launcher/startup.mjs';

process.env.PATH = `${PATH_PREFIX}:${process.env.PATH ?? ''}`;
const releaseVersion = process.env.WELES_WORKER_RELEASE_VERSION ?? '';
const releaseSha256 = process.env.WELES_WORKER_RELEASE_SHA256 ?? '';
for (const path of ENV_FILES) loadEnvFile(path);
if (releaseVersion && releaseSha256) {
  process.env.WELES_WORKER_RELEASE_VERSION = releaseVersion;
  process.env.WELES_WORKER_RELEASE_SHA256 = releaseSha256;
}

process.env.WELES_API_HOST = process.env.WELES_API_HOST || '0.0.0.0';
process.env.WELES_API_PORT = process.env.WELES_API_PORT || '8788';
const port = process.env.WELES_API_PORT;

// Refuse another service process before acquiring credentials. This observation
// is not a lock: the API's bind arbitrates racing starts. Neither contender
// creates, removes, or stops the shared Skarbiec broker.
//
// What it says matters as much as what it does. On 2026-09-21 Brama's
// sign-in for one of the operator's five accounts died with
// `hyper::Error(IncompleteMessage)` against this port, and this unit's whole
// log was `port 8788 is already served: standing by`, once a minute, for
// hours: no holder, no health, and `stado service status weles-api` reading
// `active` the entire time. So the holder is named, and it is asked whether
// it is a Weles at all. A stranger on this port is not a reason to stand by
// quietly — the unit exits nonzero so the fleet sees a service that is not
// serving.
const lsof = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
const served = spawnSync(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
if (served.status === 0 && served.stdout.trim()) {
  const holder = portHolder(served.stdout);
  const health = await holderHealth(port);
  if (health.weles) {
    refuse(
      `weles api port ${port} is already served by ${holder}, which answers /healthz as ${health.source}` +
        `${health.version ? ` version ${health.version}` : ''}: refusing a duplicate service process. ` +
        'The existing API was not stopped. Retire the duplicate service declaration through Stado.',
    );
  } else {
    refuse(
      `weles api port ${port} is held by ${holder}, which is not a Weles API: ${health.detail}. ` +
        'This unit cannot serve while that process holds the port, and standing by would leave the ' +
        'service reported as active while every caller of /reauth and /run fails. Stop or re-place the ' +
        'holder, then let this unit start: `stado service restart weles-api`.',
    );
  }
} else {
  await startup();
}
