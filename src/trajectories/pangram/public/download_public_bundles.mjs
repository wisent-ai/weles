// Download Pangram public homepage bundles and summarize public-checker modules.
// Read-only: no text submission, no accounts, no CAPTCHA bypass.

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const OUT = process.env.OUT_DIR || '/tmp/pangram-public-bundles';
mkdirSync(OUT, { recursive: true });

const homeResp = await fetch('https://www.pangram.com/');
const home = await homeResp.text();
writeFileSync(join(OUT, 'home.html'), home);

const urls = Array.from(new Set([...home.matchAll(/<script[^>]+src="([^"]+\.js)"/g)]
  .map((m) => new URL(m[1], 'https://www.pangram.com/').toString())
  .filter((u) => u.includes('/_next/static/'))));

const summary = [];
for (const url of urls) {
  const resp = await fetch(url);
  const text = await resp.text();
  const file = join(OUT, basename(new URL(url).pathname));
  writeFileSync(file, text);
  const needles = ['anonymous-scan', 'turnstile', 'Scan for AI', 'Free scans', 'feature_disabled', 'classify-text-sliding-window'];
  const hits = needles.filter((n) => text.toLowerCase().includes(n.toLowerCase()));
  if (hits.length) {
    const contexts = {};
    for (const n of hits) {
      const idx = text.toLowerCase().indexOf(n.toLowerCase());
      contexts[n] = text.slice(Math.max(0, idx - 700), Math.min(text.length, idx + n.length + 1200));
    }
    summary.push({ url, file, bytes: Buffer.byteLength(text), hits, contexts });
  }
}

const out = { outDir: OUT, homeStatus: homeResp.status, scriptCount: urls.length, matches: summary };
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  outDir: OUT,
  homeStatus: homeResp.status,
  scriptCount: urls.length,
  matchCount: summary.length,
  matches: summary.map((m) => ({ file: m.file, hits: m.hits })),
}, null, 2));
