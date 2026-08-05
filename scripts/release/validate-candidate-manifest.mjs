#!/usr/bin/env node

import { resolve } from 'node:path';
import { loadManifest, parseArgs, requiredArg } from './lib.mjs';

const args = parseArgs();
const path = resolve(requiredArg(args, 'manifest'));
const expectedSourceRevision = requiredArg(args, 'source-revision');
const expectedCandidateTag = requiredArg(args, 'candidate-tag');
const loaded = await loadManifest(path);
if (loaded.manifest.sourceRevision !== expectedSourceRevision) {
  throw new Error(`manifest sourceRevision ${loaded.manifest.sourceRevision} does not match release target ${expectedSourceRevision}`);
}
const candidateTag = `candidate-deployment-${loaded.manifest.deploymentId}-${expectedSourceRevision.slice(0, 8)}`;
if (candidateTag !== expectedCandidateTag) {
  throw new Error(`candidate tag ${expectedCandidateTag} does not match manifest ${candidateTag}`);
}
process.stdout.write(`${JSON.stringify({
  schema: loaded.manifest.schema,
  deploymentId: loaded.manifest.deploymentId,
  sourceRevision: loaded.manifest.sourceRevision,
  sha256: loaded.sha256,
}, null, 2)}\n`);
