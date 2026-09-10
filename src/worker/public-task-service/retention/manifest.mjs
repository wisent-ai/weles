import { sign as signPayload } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { EvidenceRetentionError } from '../wire.mjs';
import { canonicalJson, sha256 } from '../wire/canonical-json.mjs';
import { atomicBufferWrite, syncDirectory } from '../durable-write.mjs';
import {
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_MANIFEST_BYTES,
  RECEIPT_MANIFEST_NAME,
  collectEvidenceFiles,
  publicEvidenceInventory,
  retainedWithheldEdges,
} from './inventory.mjs';

export const RECEIPT_SCHEMA = 'weles.receipt.current';
const EVIDENCE_SCHEMA = 'weles.browser-evidence-manifest.v1';
const NON_SUCCESS_EVIDENCE_SCHEMA = 'weles.browser-evidence-manifest.v2';
const POLICY_FILE_NAME = 'browser_evidence_policy.json';

function receiptFor(task, evidenceDigest, config) {
  const outcome = task.completion.status === 'succeeded'
    ? 'completed'
    : task.completion.status;
  const coreClaims = {
    taskId: task.id,
    organizationId: task.request.organizationId,
    origin: task.request.origin,
    action: task.request.action,
    outcome,
    evidenceDigest,
  };
  const claims = {
    ...coreClaims,
    requestDigest: task.requestDigest,
    resultDigest: task.completion.resultDigest,
    spisBinding: task.spisBinding,
  };
  const signedPayload = canonicalJson(claims);
  const signature = signPayload(null, Buffer.from(signedPayload, 'utf8'), config.privateKey).toString('base64');
  return {
    schema: RECEIPT_SCHEMA,
    ...coreClaims,
    requestDigest: task.requestDigest,
    resultDigest: task.completion.resultDigest,
    spisBinding: task.spisBinding,
    keyId: config.keyId,
    signature,
    signedPayload,
  };
}

export function createEvidenceManifest({
  config,
  recordingsRoot,
  persistTask,
  uploadArtifacts,
  readArtifactIdentity,
  convertEvidenceFailure,
}) {
  async function finalize(task) {
    if (!task.completion || task.receipt) return task;
    const runRoot = join(recordingsRoot, task.id);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await syncDirectory(recordingsRoot);
    let files;
    try {
      files = await collectEvidenceFiles(runRoot);
    } catch (error) {
      if (!(error instanceof EvidenceRetentionError)) throw error;
      await convertEvidenceFailure(task, error);
      files = await collectEvidenceFiles(runRoot);
    }
    const evidenceInventory = publicEvidenceInventory(files, task.id);
    if (task.completion.status === 'succeeded') {
      const screenshot = evidenceInventory.find((entry) => entry.kind === 'screenshot');
      const accessibilityTree = evidenceInventory.find((entry) => entry.kind === 'accessibility_tree');
      if (!screenshot || !accessibilityTree || screenshot.bytes <= 0 || accessibilityTree.bytes <= 0) {
        throw new EvidenceRetentionError('required-evidence-missing', 'successful browser-evidence task lacks required screenshot or accessibility tree');
      }
      if (!files.some((file) => basename(file.path) === POLICY_FILE_NAME)) {
        throw new EvidenceRetentionError('policy-evidence-missing', 'successful browser-evidence task has no retained policy document');
      }
    }
    const kinds = evidenceInventory.map((entry) => entry.kind);
    const uris = evidenceInventory.map((entry) => entry.uri);
    if (new Set(kinds).size !== kinds.length || new Set(uris).size !== uris.length) {
      throw new EvidenceRetentionError('evidence-identity-duplicate', 'evidence inventory kind and URI identities must be unique');
    }
    const withheldEdges = await retainedWithheldEdges(files);
    const successful = task.completion.status === 'succeeded';
    const manifest = {
      schema: successful ? EVIDENCE_SCHEMA : NON_SUCCESS_EVIDENCE_SCHEMA,
      taskId: task.id,
      organizationId: task.request.organizationId,
      origin: task.request.origin,
      action: task.request.action,
      outcome: successful ? 'completed' : task.completion.status,
      requestDigest: task.requestDigest,
      resultDigest: task.completion.resultDigest,
      spisBinding: task.spisBinding,
      requestedUrl: task.executionInput.url,
      ...(successful ? {
        effectiveUrl: task.completion.capture.effectiveUrl,
        finalUrl: task.completion.capture.finalUrl,
      } : {}),
      evidenceInventory,
    };
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
    if (manifestBytes.byteLength > MAX_EVIDENCE_MANIFEST_BYTES) {
      throw new EvidenceRetentionError('evidence-manifest-too-large', 'canonical evidence manifest exceeds the 4 MiB limit');
    }
    const manifestPath = join(runRoot, RECEIPT_MANIFEST_NAME);
    try {
      const metadata = await lstat(manifestPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_EVIDENCE_MANIFEST_BYTES) {
        throw new EvidenceRetentionError('evidence-manifest-unsafe', 'existing evidence manifest is unsafe or oversized');
      }
      const existing = await readFile(manifestPath);
      if (!existing.equals(manifestBytes)) {
        throw new EvidenceRetentionError('evidence-manifest-conflict', 'existing evidence manifest disagrees with recomputed immutable task identity');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await atomicBufferWrite(manifestPath, manifestBytes);
    }

    const locators = await uploadArtifacts(task.id);
    const manifestUri = `stado://weles/recordings/${task.id}/${RECEIPT_MANIFEST_NAME}`;
    const retained = locators && Object.values(locators).some((entries) => Array.isArray(entries) && entries.includes(manifestUri));
    if (!retained) throw new Error('durable artifact storage did not acknowledge the exact evidence manifest');
    const stableFiles = await collectEvidenceFiles(runRoot);
    const stableInventory = publicEvidenceInventory(stableFiles, task.id);
    if (canonicalJson(stableInventory) !== canonicalJson(evidenceInventory)) {
      throw new EvidenceRetentionError('evidence-changed', 'evidence changed between hashing and durable retention');
    }
    const manifestReadback = await readArtifactIdentity(manifestUri, MAX_EVIDENCE_MANIFEST_BYTES);
    if (manifestReadback.bytes !== manifestBytes.byteLength
        || manifestReadback.sha256 !== sha256(manifestBytes)) {
      throw new Error('durable evidence manifest readback differs from the retained canonical bytes');
    }
    for (const entry of evidenceInventory) {
      const readback = await readArtifactIdentity(entry.uri, MAX_EVIDENCE_FILE_BYTES);
      if (readback.bytes !== entry.bytes || readback.sha256 !== entry.sha256) {
        throw new Error(`durable evidence readback differs from inventory: ${entry.kind}`);
      }
    }
    const stableWithheldEdges = await retainedWithheldEdges(stableFiles);
    if (canonicalJson(stableWithheldEdges) !== canonicalJson(withheldEdges)) {
      throw new EvidenceRetentionError('withheld-edge-changed', 'withheld-edge evidence changed before receipt signing');
    }

    const evidenceDigest = sha256(manifestBytes);
    const receipt = receiptFor(task, evidenceDigest, config);
    task.status = task.completion.status;
    task.resultDigest = task.completion.resultDigest;
    task.result = {
      ...task.completion.result,
      evidenceManifest: { uri: manifestUri, sha256: evidenceDigest },
      withheldEdgeCount: withheldEdges.length,
    };
    task.captureIdentity = task.completion.capture;
    task.error = task.completion.error;
    task.receipt = receipt;
    task.evidence = {
      manifestUri,
      sha256: evidenceDigest,
      inventory: evidenceInventory,
      keyId: config.keyId,
      keySetVersion: config.keySetVersion,
      policyVersion: config.policy.version,
      policyDigest: config.policyDigest,
      requestDigest: task.requestDigest,
      resultDigest: task.completion.resultDigest,
      spisBinding: task.spisBinding,
    };
    delete task.evidenceError;
    await persistTask(task);
    return task;
  }

  return Object.freeze({ finalize });
}
