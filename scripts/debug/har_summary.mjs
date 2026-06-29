#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/debug/har_summary.mjs <session.har>');
  process.exit(1);
}

const har = JSON.parse(readFileSync(path, 'utf8'));
const entries = har.log?.entries || [];
const rows = entries.map((entry) => ({
  url: entry.request?.url || '',
  method: entry.request?.method || '',
  status: entry.response?.status ?? -1,
  mime: entry.response?.content?.mimeType || '',
  error: entry.response?._error || entry._error || '',
  type: entry._resourceType || '',
}));

const interesting = rows.filter((row) => /linkedin|licdn|checkpoint|signup|voyager/.test(row.url));
const failures = interesting.filter((row) => row.status >= 400 || row.status === 0 || row.error);
const assets = interesting.filter((row) => /javascript|css|font|image/.test(row.mime));

console.log(`entries=${rows.length} linkedin=${interesting.length} failures=${failures.length} assets=${assets.length}`);
console.log('\n[failures]');
for (const row of failures.slice(0, 120)) {
  console.log(`${row.status} ${row.mime} ${row.method} ${row.url.slice(0, 220)} ${row.error}`);
}
console.log('\n[assets]');
for (const row of assets.slice(0, 120)) {
  console.log(`${row.status} ${row.mime} ${row.method} ${row.url.slice(0, 220)} ${row.error}`);
}
