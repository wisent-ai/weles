#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest, parseArgs, requiredArg } from './lib.mjs';

const args = parseArgs();
const sourcePath = resolve(requiredArg(args, 'manifest'));
const receiptPath = resolve(requiredArg(args, 'stado-receipt'));
const sourceRevision = requiredArg(args, 'source-revision');
const loaded = await loadManifest(sourcePath);
if (loaded.manifest.sourceRevision !== sourceRevision) {
  throw new Error(`manifest sourceRevision ${loaded.manifest.sourceRevision} does not match ${sourceRevision}`);
}
const manifestUri = `stado://releases/weles-deployment/${loaded.manifest.deploymentId}/composite/deployment-manifest.json`;
const expectedUri = args.get('manifest-uri');
if (expectedUri && expectedUri !== manifestUri) {
  throw new Error(`manifest URI must be ${manifestUri}`);
}
const receiptBytes = readFileSync(receiptPath);
const receipt = JSON.parse(receiptBytes.toString('utf8'));
if (receipt.schema_version !== 1
    || receipt.manifest_uri !== manifestUri
    || receipt.manifest_sha256 !== loaded.sha256
    || receipt.source_revision !== sourceRevision) {
  throw new Error('Stado receipt is not bound to the exact manifest URI, digest, and source revision');
}
const receiptSha256 = createHash('sha256').update(receiptBytes).digest('hex');
const receiptUri = `stado://releases/weles-deployment/${loaded.manifest.deploymentId}/composite/deployment-manifest.receipt.json`;
const stado = process.env.STADO_BIN?.trim() || 'stado';
if (process.env.STADO_API_URL && !process.env.STADO_API_TOKEN) {
  throw new Error('remote publication requires a product-scoped STADO_API_TOKEN acquired from Skarbiec');
}

function publish(uri, path) {
  try {
    execFileSync(stado, ['storage', 'put', uri, path, '--if-absent'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return;
  } catch (error) {
    const existing = join(tmpdir(), `weles-release-${process.pid}-${createHash('sha256').update(uri).digest('hex')}`);
    try {
      execFileSync(stado, ['storage', 'get', uri, existing], { stdio: ['ignore', 'pipe', 'pipe'] });
      const expected = createHash('sha256').update(readFileSync(path)).digest('hex');
      const observed = createHash('sha256').update(readFileSync(existing)).digest('hex');
      if (expected !== observed) throw new Error(`immutable Stado collision at ${uri}`);
    } finally {
      rmSync(existing, { force: true });
    }
  }
}

publish(manifestUri, sourcePath);
publish(receiptUri, receiptPath);
process.stdout.write(`${JSON.stringify({
  manifestUri,
  manifestSha256: loaded.sha256,
  receiptUri,
  receiptSha256,
  sourceRevision,
}, null, 2)}\n`);
