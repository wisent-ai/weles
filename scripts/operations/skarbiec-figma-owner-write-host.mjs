#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

const [endpoint, consumer, item, field, tokenFile, operation, operationId] = process.argv.slice(2);
if (endpoint !== 'http://127.0.0.1:8895'
    || consumer !== 'weles-figma-personal-access-token-writer'
    || item !== 'weles-figma-personal-access-token'
    || field !== 'api_key'
    || operation !== 'acquire'
    || !/^[a-f0-9]{64}$/i.test(operationId || '')) {
  throw new Error('Figma owner write received coordinates outside its exact contract');
}
const tokenMetadata = lstatSync(tokenFile);
if (!tokenMetadata.isFile() || tokenMetadata.isSymbolicLink()
    || tokenMetadata.uid !== process.getuid()
    || (tokenMetadata.mode & 0o077) !== 0) {
  throw new Error('Figma owner write received an unsafe writer binding');
}
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 65536) throw new Error('Figma credential payload exceeded its size limit');
  chunks.push(chunk);
}
const input = Buffer.concat(chunks);
try {
  const payload = JSON.parse(input.toString('utf8'));
  if (payload?.schema !== 'skarbiec.item.v2'
      || payload?.kind !== 'api-key'
      || !payload.fields || typeof payload.fields !== 'object'
      || Array.isArray(payload.fields)
      || Object.keys(payload.fields).join('|') !== 'api_key'
      || typeof payload.fields.api_key !== 'string') {
    throw new Error('Figma owner write requires one canonical api_key payload');
  }
  const skarbiec = join(process.env.HOME, '.stado', 'bin', 'skarbiec');
  const result = spawnSync(skarbiec, ['set-json', item, '--type', 'api-key'], {
    input,
    env: {
      ...process.env,
      SKARBIEC_VAULT_FILE: join(process.env.HOME, '.stado', 'skarbiec.vault.json'),
    },
    stdio: ['pipe', 'ignore', 'pipe'],
    maxBuffer: 65536,
  });
  if (result.status !== 0) {
    const reason = String(result.stderr || '').match(/Error: ([^\r\n]{1,240})/)?.[1]
      ?.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]') || 'unknown failure';
    throw new Error(`Skarbiec owner write failed: ${reason}`);
  }
} finally {
  input.fill(0);
  for (const chunk of chunks) chunk.fill(0);
}
