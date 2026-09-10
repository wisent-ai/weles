// Summarize Pangram HAR API/navigation entries. Read-only diagnostic.

import { readFileSync } from 'node:fs';

const harPath = process.argv[2];
if (!harPath) throw new Error('usage: node summarize_har.mjs <session.har>');

const har = JSON.parse(readFileSync(harPath, 'utf8'));
const entries = har?.log?.entries || [];
const rows = entries
  .filter((e) => /pangram\.com|web\.pangram\.com|challenges\.cloudflare\.com/i.test(e.request?.url || ''))
  .map((e) => {
    const req = e.request || {};
    const res = e.response || {};
    const contentText = res.content?.text || '';
    const body = contentText.length > 2000 ? `${contentText.slice(0, 2000)}...` : contentText;
    return {
      method: req.method,
      url: req.url,
      status: res.status,
      mimeType: res.content?.mimeType || null,
      requestPostSample: req.postData?.text ? req.postData.text.slice(0, 500) : null,
      responseSample: /api|signup|dashboard|anonymous|session|feature|csrf|turnstile|classify/i.test(req.url)
        ? body.replace(/\s+/g, ' ').slice(0, 1200)
        : undefined,
    };
  });

console.log(JSON.stringify({ harPath, count: rows.length, rows }, null, 2));
