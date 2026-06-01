// Fully-automated App Store Connect binary delivery via `xcrun altool`.
//
// App Store Connect has no web upload form for the .ipa; the sanctioned
// non-GUI path is altool's --upload-app with an App Store Connect API key.
// This module places the .p8 where altool expects it and runs the upload
// headlessly so asc_submit can drive the whole submission in one shot with
// no human/Transporter step.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Upload an .ipa to App Store Connect. Throws with altool's stderr on any
// non-zero exit so the caller surfaces the real reason — no sentinel returns.
// opts: { ipaPath, keyId, issuerId, p8Path, platform }  (platform default 'ios')
export async function uploadIpa(opts) {
  const ipaPath = opts.ipaPath;
  const keyId = opts.keyId;
  const issuerId = opts.issuerId;
  const p8Path = opts.p8Path;
  const platform = opts.platform || 'ios';

  if (!ipaPath || !existsSync(ipaPath)) throw new Error(`IPA not found: ${ipaPath}`);
  if (!keyId) throw new Error('ASC_KEY_ID required for altool upload');
  if (!issuerId) throw new Error('ASC_ISSUER_ID required for altool upload');
  if (!p8Path || !existsSync(p8Path)) throw new Error(`ASC_KEY_P8 (.p8) not found: ${p8Path}`);

  // altool reads AuthKey_<keyId>.p8 from ~/.appstoreconnect/private_keys.
  const keyDir = join(homedir(), '.appstoreconnect', 'private_keys');
  mkdirSync(keyDir, { recursive: true });
  const dest = join(keyDir, `AuthKey_${keyId}.p8`);
  if (!existsSync(dest)) copyFileSync(p8Path, dest);

  const args = ['altool', '--upload-app', '-f', ipaPath, '-t', platform,
    '--apiKey', keyId, '--apiIssuer', issuerId, '--output-format', 'json'];

  console.log(`[altool] uploading ${ipaPath} (${platform}) with key ${keyId}`);
  return await new Promise((resolve, reject) => {
    const cp = spawn('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => { out += d.toString(); });
    cp.stderr.on('data', (d) => { err += d.toString(); });
    cp.on('error', reject);
    cp.on('close', (code) => {
      if (code === 0) { console.log('[altool] upload accepted'); resolve({ ok: true, stdout: out }); return; }
      reject(new Error(`altool exit ${code}: ${(err || out).slice(0, 500)}`));
    });
  });
}
