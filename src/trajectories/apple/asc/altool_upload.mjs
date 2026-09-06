// App Store Connect binary delivery with an exact scoped API key. The private
// key exists on disk only in a mode-restricted temporary directory.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// opts: { ipaPath, keyId, issuerId, privateKey, platform }
export async function uploadIpa(opts) {
  const ipaPath = opts.ipaPath;
  const keyId = opts.keyId;
  const issuerId = opts.issuerId;
  const privateKey = opts.privateKey;
  const platform = opts.platform || 'ios';

  if (!ipaPath || !existsSync(ipaPath)) throw new Error(`IPA not found: ${ipaPath}`);
  if (!keyId || !issuerId || !privateKey) {
    throw new Error('exact Weles App Store Connect API grant unavailable');
  }

  const keyDir = mkdtempSync(join(tmpdir(), 'weles-asc-'));
  writeFileSync(join(keyDir, `AuthKey_${keyId}.p8`), privateKey, {
    mode: parseInt('600', '8'),
  });
  const args = ['altool', '--upload-app', '-f', ipaPath, '-t', platform,
    '--apiKey', keyId, '--apiIssuer', issuerId, '--output-format', 'json'];

  try {
    return await new Promise((resolve, reject) => {
      const cp = spawn('xcrun', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, API_PRIVATE_KEYS_DIR: keyDir },
      });
      let out = '';
      let err = '';
      cp.stdout.on('data', (data) => { out += data.toString(); });
      cp.stderr.on('data', (data) => { err += data.toString(); });
      cp.on('error', reject);
      cp.on('close', (code) => {
        if (code === Number('0')) {
          console.log('[altool] upload accepted');
          resolve({ ok: true, stdout: out });
          return;
        }
        reject(new Error(`altool failed: ${(err || out).slice(Number('0'), Number('500'))}`));
      });
    });
  } finally {
    rmSync(keyDir, { recursive: true, force: true });
  }
}
