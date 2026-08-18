import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'recordings/local/linkedin_login/session.har';
const har = JSON.parse(readFileSync(path, 'utf8'));

for (const entry of har.log.entries || []) {
  const url = entry.request?.url || '';
  if (!/accounts\.google|play\.google|linkedin\.com\/login|gsi|oauth|signin/i.test(url)) continue;
  const extra = [];
  if (entry.response?.status === -1) {
    extra.push(`started=${entry.startedDateTime}`);
    extra.push(`time=${entry.time}`);
    if (entry._failureText) extra.push(`failure=${entry._failureText}`);
    if (entry.response?._error) extra.push(`error=${entry.response._error}`);
  }
  console.log(`${entry.response?.status ?? '?'} ${entry.request?.method ?? '?'} ${url.slice(0, 500)}${extra.length ? ' :: ' + extra.join(' ') : ''}`);
}
