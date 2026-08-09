#!/usr/bin/env node

import { join } from 'node:path';
import {
  fetchManifest,
  hostPlatform,
  installArtifact,
  parseArgs,
  releaseRoot,
  requiredArg,
  selectArtifact,
  stateRoot,
  writeAtomic,
} from './lib.mjs';

const args = parseArgs();
const manifestUri = requiredArg(args, 'manifest-uri');
const expectedManifestSha256 = requiredArg(args, 'manifest-sha256');
const platform = args.get('platform') ?? hostPlatform();
const releases = releaseRoot(args);
const state = stateRoot(args);
const loaded = await fetchManifest(manifestUri, expectedManifestSha256, releases);
const { manifest } = loaded;

const worker = await installArtifact({
  artifact: selectArtifact(manifest.worker, platform),
  component: 'worker',
  releaseId: manifest.worker.version,
  manifestSha256: loaded.sha256,
  root: releases,
});
const chromium = await installArtifact({
  artifact: selectArtifact(manifest.browsers.chromium, platform),
  component: 'chromium',
  releaseId: manifest.browsers.chromium.release,
  manifestSha256: loaded.sha256,
  root: releases,
});
const firefox = await installArtifact({
  artifact: selectArtifact(manifest.browsers.firefox, platform),
  component: 'firefox',
  releaseId: manifest.browsers.firefox.release,
  manifestSha256: loaded.sha256,
  root: releases,
});

const installation = {
  schema: 'weles.installation.v2',
  manifestSha256: loaded.sha256,
  manifestPath: loaded.path,
  deploymentId: manifest.deploymentId,
  platform,
  installedAt: new Date().toISOString(),
  components: {
    worker: { destination: worker.destination, entrypoint: worker.entrypoint },
    chromium: { destination: chromium.destination, entrypoint: chromium.entrypoint },
    firefox: { destination: firefox.destination, entrypoint: firefox.entrypoint },
  },
};
await writeAtomic(join(state, 'installations', `${loaded.sha256}.json`), `${JSON.stringify(installation, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(installation, null, 2)}\n`);
