// Read-only export of Google Drive comments for a Google Docs file.
//
// Run:
//   node src/trajectories/google/drive/export_comments_api.mjs \
//     --doc <google-doc-id> --out /path/comments.json [--pickle gmail_token.pickle]

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DOC_ID = arg('--doc') || process.env.DOC_ID;
const OUT = arg('--out');
const PICKLE = arg('--pickle') || process.env.GOOGLE_TOKEN_PICKLE || 'gmail_token.pickle';

if (!DOC_ID) {
  console.error('FAIL: --doc (or DOC_ID) required');
  process.exit(2);
}

const PYTHON = '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12';
const LOAD_TOKEN = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/src/lib/load_growth_token.py';

const tokRes = spawnSync(PYTHON, [LOAD_TOKEN, '--pickle', PICKLE], { encoding: 'utf8' });
const token = (tokRes.stdout || '').trim();
if (!token || tokRes.status !== 0) {
  console.error('FAIL: load_growth_token: ' + (tokRes.stderr || '').slice(0, 300));
  process.exit(1);
}

const fields = [
  'nextPageToken,',
  'comments(id,content,createdTime,modifiedTime,deleted,resolved,',
  'author(displayName,emailAddress),',
  'quotedFileContent(mimeType,value),',
  'replies(id,content,createdTime,modifiedTime,deleted,',
  'author(displayName,emailAddress)))',
].join('');

const comments = [];
let pageToken = '';
let status = 200;
let errorBody = '';

for (;;) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${DOC_ID}/comments`);
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('fields', fields);
  url.searchParams.set('includeDeleted', 'false');
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const text = await resp.text();
  status = resp.status;
  if (!resp.ok) {
    errorBody = text.slice(0, 1200);
    break;
  }
  const data = JSON.parse(text);
  comments.push(...(data.comments || []));
  pageToken = data.nextPageToken || '';
  if (!pageToken) break;
}

const out = {
  docId: DOC_ID,
  exportedAt: new Date().toISOString(),
  pickle: PICKLE,
  status,
  count: comments.length,
  comments,
  errorBody,
};

const json = JSON.stringify(out, null, 2);
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(JSON.stringify({ wrote: OUT, status, count: comments.length }, null, 2));
} else {
  console.log(json);
}

if (status >= 400) process.exit(2);
