#!/usr/bin/env node

import { resolve } from 'node:path';
import { loadManifest, parseArgs, requiredArg } from './lib.mjs';

const args = parseArgs();
const path = resolve(requiredArg(args, 'manifest'));
const expectedSourceRevision = requiredArg(args, 'source-revision');
const expectedCandidateUri = requiredArg(args, 'candidate-uri');
const loaded = await loadManifest(path);
if (loaded.manifest.sourceRevision !== expectedSourceRevision) {
  throw new Error(`manifest sourceRevision ${loaded.manifest.sourceRevision} does not match release target ${expectedSourceRevision}`);
}
const candidateUri = `stado://releases/weles-deployment/${loaded.manifest.deploymentId}/composite/deployment-manifest.json`;
if (candidateUri !== expectedCandidateUri) {
  throw new Error(`candidate URI ${expectedCandidateUri} does not match manifest ${candidateUri}`);
}
process.stdout.write(`${JSON.stringify({
  schema: loaded.manifest.schema,
  deploymentId: loaded.manifest.deploymentId,
  sourceRevision: loaded.manifest.sourceRevision,
  candidateUri,
  sha256: loaded.sha256,
}, null, 2)}\n`);
