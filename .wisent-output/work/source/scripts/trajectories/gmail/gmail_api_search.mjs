// Gmail API search using the existing growth-tactics OAuth pickle.
// Bypasses the Chromium-driven gmail_login_search trajectory — calls
// users.messages.list + users.messages.get directly over HTTPS with
// the wisent.ai access token from growth-tactics/google_drive/
// gmail_token.pickle (gmail.readonly + drive scope, already consented).
//
// Run:
//   node weles/scripts/trajectories/gmail/gmail_api_search.mjs \
//     --q '"rent board" newer_than:30d' [--max 10]
// Env mirror: GM_QUERY, GM_MAX.

import { spawnSync } from 'node:child_process';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUERY = arg('--q') || process.env.GM_QUERY;
const MAX = parseInt(arg('--max') || process.env.GM_MAX || '10', 10);

if (!QUERY) { console.log('FAIL: --q (or GM_QUERY) required'); process.exit(2); }

const PYTHON = '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12';
const LOAD_TOKEN = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/scripts/lib/load_growth_token.py';

const tokRes = spawnSync(PYTHON, [LOAD_TOKEN, '--pickle', 'gmail_token.pickle'], { encoding: 'utf8' });
const token = (tokRes.stdout || '').trim();
if (!token || tokRes.status !== 0) {
  console.log('FAIL: load_growth_token: ' + (tokRes.stderr || '').slice(0, 300));
  process.exit(1);
}

const auth = { Authorization: 'Bearer ' + token };

// 1. list message IDs matching the query
const listUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent(QUERY) + '&maxResults=' + MAX;
const listResp = await fetch(listUrl, { headers: auth });
if (!listResp.ok) {
  console.log('FAIL: list HTTP ' + listResp.status + ' ' + (await listResp.text()).slice(0, 300));
  process.exit(1);
}
const listData = await listResp.json();
const ids = (listData.messages || []).map((m) => m.id);
console.log('[gmail_api_search] matches: ' + ids.length);

// 2. fetch headers + snippet for each
const out = [];
for (const id of ids) {
  const detUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date';
  const det = await fetch(detUrl, { headers: auth });
  if (!det.ok) {
    out.push({ id, error: det.status });
    continue;
  }
  const d = await det.json();
  const headers = {};
  for (const h of d.payload?.headers || []) { headers[h.name] = h.value; }
  out.push({
    id,
    from: headers.From || '',
    subject: headers.Subject || '',
    date: headers.Date || '',
    snippet: (d.snippet || '').slice(0, 200),
  });
}
console.log(JSON.stringify(out, null, 2));
