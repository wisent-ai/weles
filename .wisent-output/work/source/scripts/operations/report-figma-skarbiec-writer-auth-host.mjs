#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const endpoint = process.env.WELES_CREDENTIAL_SKARBIEC_URL || process.env.WC_SKARBIEC_URL;
if (!endpoint) throw new Error('Skarbiec endpoint is missing');
const token = readFileSync(join(
  process.env.HOME,
  '.stado',
  'weles-figma-personal-access-token-writer-skarbiec-token',
));
try {
  const bearer = token.toString('utf8');
  if (!bearer || /\s/.test(bearer)) throw new Error('Figma writer bearer file is invalid');
  const response = await fetch(new URL('/v1/items', endpoint), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      'X-Consumer': 'weles-figma-personal-access-token-writer',
    },
    body: JSON.stringify({
      id: 'weles-figma-personal-access-token',
      field: 'api_key',
      value: 'diagnostic-not-a-secret',
      mode: 'stage',
      operation_id: 'invalid',
      provider_verified: true,
    }),
  });
  const responseText = (await response.text()).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
  console.log(JSON.stringify({
    endpoint,
    status: response.status,
    authorized: response.status !== 401 && response.status !== 403,
    response: responseText.slice(0, 300),
  }));
} finally {
  token.fill(0);
}
