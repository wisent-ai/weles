// Uploads complete trajectory artifact trees through Stado's authenticated
// product object API. Every artifact remains private under stado://weles/ and
// result rows receive only canonical private locators.
//
// Every file under recordings/<run_uuid>/ belongs to that run and is mirrored
// with its relative path intact. There is no extension allowlist, mtime window,
// or per-kind cap: HAR, PCAP, DOM, logs, screenshots, video, JSON, and unknown
// forensic formats all cross the same private authenticated boundary.
//
// Configuration and upload failures are fatal. A caller may publish locators
// only after Stado acknowledges the exact canonical URI for every object.

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ARTIFACT_KINDS,
  artifactFileType,
  type ArtifactFileType,
  type ArtifactLocatorSet,
} from './artifacts/artifact-delivery.js';
import {
  assertStorageReceipt,
  privateStadoUri,
  requireStadoObjectConfig,
} from './objects/stado-object.js';
import { recordingsBase } from '../session/run-recordings.js';

const OBJECT_NAMESPACE = 'weles';
const ARTIFACT_PREFIX = 'recordings';
const UPLOAD_PROOF_NAME = '.uploaded.json';
const UPLOAD_PROOF_SCHEMA = 'weles.upload-proof.v1';

/** The cause an error carries, as text. */
function causeOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The sum of `sizes`; a list with no sizes is refused by the caller first. */
function total(sizes: readonly number[]): number {
  return sizes.reduce((sum, size) => sum + size);
}

// namespace is explicit at every call site: the recordings uploader writes into
// `weles`, the capture actions into `weles-captures`, and nothing may invent a
// third namespace without declaring it in ./objects/stado-object.ts.
export async function putPrivateStadoObject(
  namespace: string,
  key: string,
  body: Uint8Array | string,
  contentType: string,
): Promise<string> {
  const config = requireStadoObjectConfig();
  const uri = privateStadoUri(namespace, key);
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const response = await fetch(
    `${config.apiUrl}/api/object?uri=${encodeURIComponent(uri)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
      },
      body: bytes as unknown as BodyInit,
    },
  );
  const responseText = await response.text().catch((cause) => {
    throw new Error(
      `Stado object upload response read failed for ${uri} (HTTP ${response.status}): ${causeOf(cause)}`,
      { cause },
    );
  });
  if (!response.ok)
    throw new Error(
      `Stado object upload failed for ${uri} (HTTP ${response.status}): ${responseText}`,
    );
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(responseText) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `Stado object upload receipt JSON read failed for ${uri} (HTTP ${response.status}): ${causeOf(cause)}`,
      { cause },
    );
  }
  assertStorageReceipt(payload, uri, bytes, contentType);
  return uri;
}

export async function readPrivateStadoObjectIdentity(
  uri: string,
  maximumBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    !maximumBytes ||
    Math.abs(maximumBytes) !== maximumBytes
  )
    throw new Error(
      `Stado object readback requires a positive safe byte limit; got ${maximumBytes}`,
    );
  if (!URL.canParse(uri))
    throw new Error(`Stado object readback URI is invalid: ${uri}`);
  const parsed = new URL(uri);
  if (
    parsed.protocol !== 'stado:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    privateStadoUri(parsed.hostname, parsed.pathname.replace(/^\//, '')) !== uri
  )
    throw new Error(`Stado object readback URI is not canonical: ${uri}`);
  const config = requireStadoObjectConfig();
  const response = await fetch(
    `${config.apiUrl}/api/object?uri=${encodeURIComponent(uri)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}` },
    },
  );
  if (!response.ok || !response.body) {
    const message = await response.text().catch((cause) => {
      throw new Error(
        `Stado object readback response read failed for ${uri} (HTTP ${response.status}): ${causeOf(cause)}`,
        { cause },
      );
    });
    throw new Error(
      `Stado object readback failed for ${uri} (HTTP ${response.status}): ${message}`,
    );
  }
  const hash = createHash('sha256');
  const sizes: number[] = [];
  const reader = response.body.getReader();
  for (;;) {
    const chunk = await reader.read().catch((cause) => {
      throw new Error(
        `Stado object readback stream failed for ${uri} (HTTP ${response.status}) after ${sizes.length} chunk(s): ${causeOf(cause)}`,
        { cause },
      );
    });
    if (chunk.done) break;
    sizes.push(chunk.value.byteLength);
    if (total(sizes) > maximumBytes) {
      await reader.cancel();
      throw new Error(
        `Stado object readback of ${uri} exceeded its byte limit of ${maximumBytes}`,
      );
    }
    hash.update(chunk.value);
  }
  // An object that streamed no chunk holds no bytes: its size is then the
  // number of chunks it streamed.
  if (!sizes.length) return { bytes: sizes.length, sha256: hash.digest('hex') };
  return { bytes: total(sizes), sha256: hash.digest('hex') };
}

type RunFile = { path: string; rel: string; type: ArtifactFileType };

/**
 * Every file under a run directory, with its path relative to it, so the
 * storage layout mirrors the on-disk tree. The upload-proof marker belongs to
 * the mirror contract, not to the run's artifacts, and is never collected.
 */
async function collectTree(root: string, relBase: string): Promise<RunFile[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (cause) => {
      throw new Error(
        `Artifact directory read failed for ${root}: ${causeOf(cause)}`,
        { cause },
      );
    },
  );
  const files: RunFile[] = [];
  for (const entry of entries) {
    if (entry.name === UPLOAD_PROOF_NAME) continue;
    const full = join(root, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectTree(full, rel)));
      continue;
    }
    // Full capture: every file goes up, under the kind and content type
    // artifact-kinds.json declares for its extension.
    files.push({
      path: full,
      rel,
      type: artifactFileType(extname(entry.name).toLowerCase()),
    });
  }
  return files;
}

export async function uploadArtifacts(
  logId: string,
): Promise<ArtifactLocatorSet | null> {
  // Artifacts are keyed by run UUID. Recursively mirror the entire
  // recordings/<run_uuid>/ tree to stado://weles/recordings/<run_uuid>/,
  // preserving every relative path and file type without per-kind caps.
  requireStadoObjectConfig();
  const runDir = join(recordingsBase(), logId);
  const files = await collectTree(runDir, '');
  if (!files.length) return null;
  const locators: ArtifactLocatorSet = Object.fromEntries(
    ARTIFACT_KINDS.map((kind) => [kind, []]),
  );
  for (const file of files) {
    const locator = await putPrivateStadoObject(
      OBJECT_NAMESPACE,
      `${ARTIFACT_PREFIX}/${logId}/${file.rel}`,
      await readFile(file.path),
      file.type.contentType,
    );
    locators[file.type.kind].push(locator);
  }
  await writeUploadProof(runDir, logId, files);
  return locators;
}

/**
 * Durable whole-run proof that the local recordings/<run>/ tree is fully
 * mirrored to private Stado objects, written only after every collected file
 * has been acknowledged with its exact canonical URI. Stado's Weles activity
 * view reads its sha256 and destination; a later write into the run directory
 * is newer than uploaded_at.
 */
async function writeUploadProof(
  runDir: string,
  logId: string,
  files: readonly RunFile[],
): Promise<void> {
  const sized = await Promise.all(
    files.map(async (file) => {
      const info = await stat(file.path).catch((cause) => {
        throw new Error(
          `Artifact proof stat failed for ${file.path}: ${causeOf(cause)}`,
          { cause },
        );
      });
      return { rel: file.rel, size: info.size };
    }),
  );
  const manifest = sized.map(({ rel, size }) => `${rel}:${size}`).sort();
  const proof = {
    schema: UPLOAD_PROOF_SCHEMA,
    run: logId,
    uploaded_at: new Date().toISOString(),
    file_count: files.length,
    total_bytes: total(sized.map(({ size }) => size)),
    sha256: createHash('sha256').update(manifest.join('\n')).digest('hex'),
    destination: `${privateStadoUri(OBJECT_NAMESPACE, `${ARTIFACT_PREFIX}/${logId}`)}/`,
  };
  await writeFile(
    join(runDir, UPLOAD_PROOF_NAME),
    `${JSON.stringify(proof)}\n`,
    'utf8',
  );
}
