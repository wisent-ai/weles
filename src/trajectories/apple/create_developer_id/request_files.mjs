// Where the certificate request and the issued certificate live during one
// create_developer_id run.
//
// A caller that runs on another machine (weles apple developer-id) sends the
// request itself as APPLE_CSR_BASE64 — a CSR is public, the private key never
// leaves the caller — and the run places it in its own output directory, owner
// only, and removes that directory when it ends. A caller already on this
// host may still name both files with APPLE_CSR_PATH / APPLE_CERTIFICATE_PATH.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOutputPath } from '#run-output';
import { absoluteWorkerPath } from './portal.mjs';

const CSR_HEADER = '-----BEGIN CERTIFICATE REQUEST-----';
const OWNER_ONLY_DIRECTORY = 0o700;
const OWNER_ONLY_FILE = 0o600;

/** The request and certificate paths of this run, and how to remove what it placed. */
export function placeRequestFiles(guardId) {
  const encoded = process.env.APPLE_CSR_BASE64?.trim() ?? '';
  if (!encoded) {
    return {
      csrPath: absoluteWorkerPath(process.env.APPLE_CSR_PATH, 'APPLE_CSR_PATH'),
      certificatePath: absoluteWorkerPath(
        process.env.APPLE_CERTIFICATE_PATH,
        'APPLE_CERTIFICATE_PATH',
      ),
      cleanup: () => undefined,
    };
  }
  const request = Buffer.from(encoded, 'base64').toString('utf8');
  if (!request.startsWith(CSR_HEADER)) {
    throw new Error(
      '[apple-create-developer-id] APPLE_CSR_BASE64 is not a PEM certificate request',
    );
  }
  const directory = runOutputPath('apple-developer-id', guardId);
  mkdirSync(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
  const csrPath = join(directory, 'request.csr');
  writeFileSync(csrPath, request, { mode: OWNER_ONLY_FILE });
  return {
    csrPath,
    certificatePath: join(directory, 'certificate.cer'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
