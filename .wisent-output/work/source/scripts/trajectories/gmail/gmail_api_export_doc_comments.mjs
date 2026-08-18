// Read-only export of Google Docs comment notification emails from Gmail.
//
// Run:
//   node scripts/trajectories/gmail/gmail_api_export_doc_comments.mjs \
//     --q 'from:comments-noreply@docs.google.com "Wisent - Szablon wniosku"' \
//     --max 100 \
//     --out /path/comments.json

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUERY = arg('--q') || process.env.GM_QUERY;
const MAX = parseInt(arg('--max') || process.env.GM_MAX || '50', 10);
const OUT = arg('--out');

if (!QUERY) {
  console.error('FAIL: --q (or GM_QUERY) required');
  process.exit(2);
}

const PYTHON = '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12';
const LOAD_TOKEN = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/scripts/lib/load_growth_token.py';

const tokRes = spawnSync(PYTHON, [LOAD_TOKEN, '--pickle', 'gmail_token.pickle'], { encoding: 'utf8' });
const token = (tokRes.stdout || '').trim();
if (!token || tokRes.status !== 0) {
  console.error('FAIL: load_growth_token: ' + (tokRes.stderr || '').slice(0, 300));
  process.exit(1);
}

const auth = { Authorization: 'Bearer ' + token };

function decodeBody(data) {
  if (!data) return '';
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function collectParts(part, out = []) {
  if (!part) return out;
  const mime = part.mimeType || '';
  const data = part.body?.data;
  if (data && (mime === 'text/plain' || mime === 'text/html')) {
    const raw = decodeBody(data);
    out.push({ mime, text: mime === 'text/html' ? htmlToText(raw) : raw.trim() });
  }
  for (const child of part.parts || []) collectParts(child, out);
  return out;
}

function headerMap(headers = []) {
  const out = {};
  for (const h of headers) out[h.name.toLowerCase()] = h.value || '';
  return out;
}

function cleanText(s) {
  return (s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractLinks(text) {
  const links = new Set();
  const re = /https?:\/\/[^\s<>"')]+/g;
  for (const m of text.matchAll(re)) {
    let u = m[0].replace(/[.,;:]+$/g, '');
    try {
      const parsed = new URL(u);
      const q = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      if (q && /^https?:\/\//.test(q)) u = q;
    } catch {}
    if (/docs\.google\.com|drive\.google\.com/.test(u)) links.add(u);
  }
  return Array.from(links);
}

function extractDocIds(text) {
  const ids = new Set();
  const re = /(?:document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{20,})/g;
  for (const m of text.matchAll(re)) ids.add(m[1]);
  return Array.from(ids);
}

function compactCommentText(text) {
  const lines = cleanText(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^Open$/i.test(l))
    .filter((l) => !/^Google Docs$/i.test(l))
    .filter((l) => !/^This email grants access/i.test(l))
    .filter((l) => !/^You received this email/i.test(l))
    .filter((l) => !/^Change what Google Docs sends/i.test(l))
    .filter((l) => !/^Google LLC/i.test(l));
  return lines.join('\n').slice(0, 12000);
}

async function getJson(url) {
  const resp = await fetch(url, { headers: auth });
  const body = await resp.text();
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + body.slice(0, 300));
  return JSON.parse(body);
}

const listUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q='
  + encodeURIComponent(QUERY)
  + '&maxResults='
  + MAX;
const listData = await getJson(listUrl);
const ids = (listData.messages || []).map((m) => m.id);

const messages = [];
for (const id of ids) {
  const detUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/'
    + id
    + '?format=full';
  const d = await getJson(detUrl);
  const headers = headerMap(d.payload?.headers || []);
  const parts = collectParts(d.payload || {});
  const bodyText = cleanText(parts.map((p) => p.text).filter(Boolean).join('\n\n'));
  const links = extractLinks(bodyText + '\n' + (d.snippet || ''));
  const docIds = extractDocIds(links.join('\n') + '\n' + bodyText);
  messages.push({
    id,
    threadId: d.threadId || '',
    date: headers.date || '',
    from: headers.from || '',
    to: headers.to || '',
    subject: headers.subject || '',
    snippet: d.snippet || '',
    docIds,
    links,
    text: compactCommentText(bodyText),
  });
}

const out = {
  query: QUERY,
  exportedAt: new Date().toISOString(),
  count: messages.length,
  docIds: Array.from(new Set(messages.flatMap((m) => m.docIds))),
  messages,
};

const json = JSON.stringify(out, null, 2);
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(JSON.stringify({ wrote: OUT, count: out.count, docIds: out.docIds }, null, 2));
} else {
  console.log(json);
}
