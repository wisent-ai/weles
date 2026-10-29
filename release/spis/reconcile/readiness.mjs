// The readings the Spis public admission reconcile takes before and after a
// release: that Stado's release status shows the exact weles-worker version
// committed and healthy on the target, that the public Weles answers ready at
// the exact service identity, and the receipt trust document Spis verifies
// Weles receipts against.
import { readFileSync } from 'node:fs';
import { arrayAt, objectAt, readJson, writeJson } from './documents.mjs';

export function releaseSettled(path, target, version, sourceRevision) {
  const report = objectAt(readJson(path), 'release status');
  const rows = arrayAt(report.targets, 'release status targets');
  const matches = rows.filter(
    (row) => row?.product === 'weles-worker' && row?.target === target,
  );
  if (matches.length !== 1)
    throw new Error('release status does not name the exact Weles target once');
  const row = matches[0];
  const artifacts = Object.values(
    objectAt(row.desired?.artifacts, 'desired release artifacts'),
  );
  const activeDigest = row.observed?.active_sha256;
  const activeArtifact = artifacts.filter(
    (artifact) =>
      artifact?.artifact_sha256 === activeDigest &&
      artifact?.source_revision === sourceRevision,
  );
  if (
    row.desired?.version !== version ||
    row.observed?.schema_version !== 1 ||
    row.observed?.product !== 'weles-worker' ||
    row.observed?.target !== target ||
    row.observed?.active_version !== version ||
    row.observed?.phase !== 'committed' ||
    typeof activeDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(activeDigest) ||
    activeArtifact.length !== 1 ||
    row.software?.verdict !== 'ok' ||
    row.software?.failed !== false
  ) {
    throw new Error(
      `weles-worker ${version} is not healthy at the exact source and digest on ${target}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      version,
      sourceRevision,
      artifactSha256: activeDigest,
      rolloutGeneration: row.observed.rollout_generation,
    })}\n`,
  );
}

export function renderTrust(
  organizationPath,
  keySetVersionPath,
  publicKeysPath,
  destination,
) {
  const organizationId = readFileSync(organizationPath, 'utf8').trim();
  const keySetVersion = readFileSync(keySetVersionPath, 'utf8').trim();
  const receiptKeys = JSON.parse(readFileSync(publicKeysPath, 'utf8'));
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      organizationId,
    )
  ) {
    throw new Error('receipt trust organizationId must be a UUID');
  }
  if (
    !keySetVersion ||
    !receiptKeys ||
    typeof receiptKeys !== 'object' ||
    Array.isArray(receiptKeys) ||
    Object.keys(receiptKeys).length === 0 ||
    Object.values(receiptKeys).some(
      (value) => typeof value !== 'string' || !value.includes('PUBLIC KEY'),
    )
  ) {
    throw new Error('receipt trust key set is invalid');
  }
  writeJson(destination, {
    schema: 'wisent.spis-weles-receipt-trust.v1',
    organizationId,
    allowedAction: 'generic_browser_task',
    receiptKeys,
    keySetVersion,
  });
}

export function versionReady(path, target, version, sourceRevision) {
  const document = objectAt(readJson(path), 'public Weles version');
  const identity = objectAt(
    document.serviceIdentity,
    'public Weles service identity',
  );
  const prerequisites = objectAt(
    document.prerequisites,
    'public Weles prerequisites',
  );
  if (
    document.schema !== 'weles.version.v1' ||
    document.service !== 'weles-admission' ||
    document.release !== version ||
    document.releaseId !== `weles-worker@${version}` ||
    document.sourceRevision !== sourceRevision ||
    !/^[0-9a-f]{64}$/.test(document.deploymentManifestSha256 ?? '') ||
    document.ready !== true ||
    Object.values(prerequisites).some((value) => value !== true) ||
    document.dispatcher?.healthy !== true ||
    identity.name !== 'weles-admission' ||
    identity.consumer !== 'spis' ||
    identity.capability !== 'browser-evidence' ||
    identity.active_host !== target ||
    identity.action !== 'generic_browser_task' ||
    identity.release_id !== `weles-worker@${version}` ||
    identity.source_revision !== sourceRevision ||
    typeof identity.endpoint !== 'string' ||
    new URL(identity.endpoint).pathname !== '/api/v1'
  ) {
    throw new Error(
      'public Weles version is not ready at the exact service, release, source, and endpoint identity',
    );
  }
}
