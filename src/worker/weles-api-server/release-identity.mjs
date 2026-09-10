// Which release this process is, and where the tree it was unpacked from sits.
//
// This is read before anything compiled is loaded, because a runtime tree can
// be marked ready while carrying another release's source identity, and a
// server that answers under a version it cannot prove is worse than one that
// never binds its port. Every identity the rest of the server signs into an
// answer -- the published service directory it claims to be, the release
// stamped into a run's recorded outcome -- is the one computed here, so there
// is a single reading of it and not one per caller.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(__dirname, '../../..');
const SOURCE_IDENTITY = JSON.parse(readFileSync(join(REPO, 'release', 'source-identity.json'), 'utf8'));
if (SOURCE_IDENTITY.schema !== 'weles.source-identity.v1'
    || SOURCE_IDENTITY.product !== 'weles-worker'
    || SOURCE_IDENTITY.version !== process.env.WELES_WORKER_RELEASE_VERSION
    || typeof SOURCE_IDENTITY.source_revision !== 'string'
    || !/^[0-9a-f]{40}$/.test(SOURCE_IDENTITY.source_revision)) {
  throw new Error('embedded Weles source identity does not match the deployed release');
}
export const RUN_RELEASE_IDENTITY = Object.freeze({
  release_version: process.env.WELES_WORKER_RELEASE_VERSION || null,
  release_sha256: process.env.WELES_WORKER_RELEASE_SHA256 || null,
  source_revision: SOURCE_IDENTITY.source_revision,
});
