#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, requiredArg, validateManifest, writeAtomic } from './lib.mjs';

const args = parseArgs();
const output = resolve(requiredArg(args, 'output'));
const fragmentNames = ['worker', 'web', 'database', 'client', 'chromium', 'firefox', 'compatibility'];
const fragments = Object.fromEntries(await Promise.all(fragmentNames.map(async (name) => {
  const path = resolve(requiredArg(args, name));
  return [name, JSON.parse(await readFile(path, 'utf8'))];
})));
const manifest = validateManifest({
  schema: 'weles.deployment.v1',
  deploymentId: requiredArg(args, 'deployment-id'),
  createdAt: requiredArg(args, 'created-at'),
  sourceRevision: requiredArg(args, 'source-revision'),
  worker: fragments.worker,
  web: fragments.web,
  database: fragments.database,
  client: fragments.client,
  browsers: {
    chromium: fragments.chromium,
    firefox: fragments.firefox,
  },
  compatibility: fragments.compatibility,
});
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
await writeAtomic(output, bytes, 0o600);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeAtomic(`${output}.sha256`, `${sha256}  ${output.split('/').at(-1)}\n`, 0o600);
process.stdout.write(`${JSON.stringify({ manifest: output, sha256 }, null, 2)}\n`);
