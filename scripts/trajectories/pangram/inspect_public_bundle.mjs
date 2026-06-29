// Read-only diagnostic helper for Pangram's public homepage bundle.
// Prints bounded context around relevant public checker symbols.

import { readFileSync } from 'node:fs';

const path = process.argv[2] || '/tmp/pangram_home_page.js';
const src = readFileSync(path, 'utf8');

const needles = [
  'Scan for AI',
  'turnstile',
  'cf-turnstile',
  'anonymous-scan/',
  'anonymous-scan/status',
  'pendingCheck',
  'classify',
  'sliding',
  'textquery',
  'examples',
  'captcha',
  'token',
  'sitekey',
  '51004:',
  'xx:',
  'Enter some text',
  '25826:',
  '97793:',
  'isDialog',
  'setInputValue',
];

const seen = new Set();
for (const needle of needles) {
  const lower = src.toLowerCase();
  let idx = lower.indexOf(needle.toLowerCase());
  let hits = 0;
  while (idx >= 0 && hits < 6) {
    const start = Math.max(0, idx - 900);
    const end = Math.min(src.length, idx + needle.length + 1600);
    const key = `${needle}:${start}`;
    if (!seen.has(key)) {
      seen.add(key);
      const prefix = src.slice(Math.max(0, idx - 30_000), idx);
      const moduleHits = [...prefix.matchAll(/(?:^|[,{])(\d+):\(([^)]*)\)=>\{/g)];
      const moduleId = moduleHits.length ? moduleHits[moduleHits.length - 1][1] : 'unknown';
      console.log(`\n===== ${needle} @ ${idx} =====`);
      console.log(`module=${moduleId}`);
      console.log(src.slice(start, end));
    }
    hits += 1;
    idx = lower.indexOf(needle.toLowerCase(), idx + needle.length);
  }
}

console.log(`\nbytes=${Buffer.byteLength(src)}`);
