#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, requiredArg } from './lib.mjs';


function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function encoded(value) {
  return Buffer.from(`${JSON.stringify(stable(value))}\n`);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const args = parseArgs();
const root = resolve(requiredArg(args, 'root'));
const version = requiredArg(args, 'version');
const platform = requiredArg(args, 'platform');
const binary = await readFile(resolve(root, 'dist/cli.js'));
const binarySha256 = digest(binary);
const releaseUri = `stado://releases/weles-worker/${version}/${platform}/weles-worker.tar.gz`;

const component = {
  schema: 'weles.worker-component.v2',
  product: 'weles-worker',
  version,
  platform,
  entrypoint: 'dist/cli.js',
  releaseIdentity: {
    uri: releaseUri,
    digestAuthority: 'stado-build-receipt',
  },
};
await writeFile(resolve(root, 'component-manifest.json'), encoded(component), { mode: 0o600 });

const subject = { name: 'dist/cli.js', digest: { sha256: binarySha256 } };
const provenance = {
  _type: 'https://in-toto.io/Statement/v1',
  predicateType: 'https://slsa.dev/provenance/v1',
  subject: [subject],
  predicate: {
    buildDefinition: {
      buildType: 'https://stado.wisent.com/build-types/weles-worker/v1',
      externalParameters: { platform, version },
      internalParameters: { lockedDependencies: true },
      resolvedDependencies: [{ uri: `stado://sources/weles/${version}` }],
    },
    runDetails: { builder: { id: 'stado://release-pipeline/v1' } },
  },
};
const provenanceBytes = encoded(provenance);
await writeFile(resolve(root, 'receipts/provenance.intoto.json'), provenanceBytes, { mode: 0o600 });

const sbomBytes = await readFile(resolve(root, 'receipts/sbom.cyclonedx.json'));
const statement = {
  _type: 'https://in-toto.io/Statement/v1',
  predicateType: 'https://stado.wisent.com/predicates/release-evidence/v1',
  subject: [subject],
  predicate: {
    platform,
    version,
    releaseUri,
    receipts: {
      provenanceSha256: digest(provenanceBytes),
      sbomSha256: digest(sbomBytes),
    },
    signingAuthority: 'stado-skarbiec',
  },
};
const payload = Buffer.from(JSON.stringify(stable(statement)));
const envelope = {
  payloadType: 'application/vnd.in-toto+json',
  payload: payload.toString('base64'),
  signatures: [],
  stadoReceiptRequired: true,
};
await writeFile(resolve(root, 'receipts/dsse-evidence.json'), encoded(envelope), { mode: 0o600 });
