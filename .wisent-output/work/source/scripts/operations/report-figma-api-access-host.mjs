#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const endpoint = process.env.WELES_CREDENTIAL_SKARBIEC_URL || process.env.WC_SKARBIEC_URL;
const acquireScript = process.env.SKARBIEC_WELES_READER_COMMAND;
const scopeFile = process.env.SKARBIEC_WELES_ACQUISITION_SCOPES_FILE;
if (!endpoint || !acquireScript || !scopeFile) throw new Error('Figma API reader coordinates are incomplete');
const consumer = 'weles-figma-design-assets-exporter';
const item = 'weles-figma-personal-access-token';
const field = 'api_key';
const acquired = spawnSync(process.execPath, [
  acquireScript, endpoint, scopeFile, consumer, item, field,
], { encoding: 'buffer', env: process.env, maxBuffer: 65536 });
if (acquired.status !== 0) throw new Error('Figma token acquisition failed');
const token = acquired.stdout;
try {
  const bearer = token.toString('utf8');
  if (bearer.length < 20 || /\s/.test(bearer)) throw new Error('Figma token acquisition returned an invalid value');
  const response = await fetch('https://api.figma.com/v1/me', {
    headers: { 'X-Figma-Token': bearer },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload.id !== 'string') {
    throw new Error(`Figma /v1/me rejected the stored token with HTTP ${response.status}`);
  }
  console.log(JSON.stringify({
    status: 'authorized',
    id: payload.id,
    handle: payload.handle || null,
    email: payload.email || null,
  }));
} finally {
  token.fill(0);
  if (Buffer.isBuffer(acquired.stderr)) acquired.stderr.fill(0);
}
