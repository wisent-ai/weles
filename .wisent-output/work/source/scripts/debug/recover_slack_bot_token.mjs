#!/usr/bin/env node
// Recover a valid Slack bot token from known local Oko/Weles artifacts.
// Never prints token values. With --write, writes the best valid xoxb token to
// ~/.oko/bot-token with 0600 permissions.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES = join(__dirname, '..', '..');
const WISENT = join(WELES, '..');
const OKO = join(WISENT, 'oko');
const WRITE = process.argv.includes('--write');

const roots = [
  join(homedir(), '.oko'),
  join(WELES, '.work'),
  join(WELES, 'recordings', 'local'),
  join(OKO, '.work'),
].filter((p) => existsSync(p));

const textExts = new Set(['.txt', '.log', '.json', '.jsonl', '.html', '.htm', '.har', '.env', '.md']);
const maxBytes = 25 * 1024 * 1024;
const tokenRegex = /xoxb-[A-Za-z0-9-]+/g;

function extname(path) {
  const base = path.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

function candidateFiles(root, out = []) {
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      candidateFiles(path, out);
      continue;
    }
    if (!entry.isFile()) continue;
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.size <= 0 || st.size > maxBytes) continue;
    if (path.endsWith('bot-token') || textExts.has(extname(path))) out.push(path);
  }
  return out;
}

function collectCandidates() {
  const found = new Map();
  if (process.env.SLACK_BOT_TOKEN?.startsWith('xoxb-')) {
    found.set(process.env.SLACK_BOT_TOKEN.trim(), { source: 'env:SLACK_BOT_TOKEN' });
  }
  for (const root of roots) {
    for (const file of candidateFiles(root)) {
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      for (const match of text.matchAll(tokenRegex)) {
        const token = match[0];
        if (!found.has(token)) found.set(token, { source: file });
      }
    }
  }
  return [...found.entries()].map(([token, meta]) => ({ token, ...meta }));
}

async function slackGet(method, token, params = {}) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
}

async function validate(candidate) {
  const auth = await slackGet('auth.test', candidate.token);
  if (!auth.ok) return { ...candidate, valid: false, error: auth.error || 'auth_failed' };
  const users = await slackGet('users.list', candidate.token, { limit: '1' });
  return {
    ...candidate,
    valid: true,
    users_read_ok: Boolean(users.ok),
    users_error: users.ok ? null : users.error || null,
    team: auth.team || null,
    team_id: auth.team_id || null,
    bot_user: auth.user || null,
    bot_user_id: auth.user_id || null,
  };
}

function writeToken(token) {
  const dir = join(homedir(), '.oko');
  const path = join(dir, 'bot-token');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

const candidates = collectCandidates();
const validated = [];
for (const candidate of candidates) validated.push(await validate(candidate));

const valid = validated.filter((x) => x.valid);
const best = valid.find((x) => x.users_read_ok) || valid[0] || null;
let written = null;
if (WRITE && best) written = writeToken(best.token);

console.log(JSON.stringify({
  ok: Boolean(best),
  candidates_seen: candidates.length,
  valid_tokens: valid.length,
  chosen: best ? {
    source: best.source,
    team: best.team,
    team_id: best.team_id,
    bot_user: best.bot_user,
    bot_user_id: best.bot_user_id,
    users_read_ok: best.users_read_ok,
    users_error: best.users_error,
  } : null,
  written,
  invalid_errors: validated.filter((x) => !x.valid).slice(0, 10).map((x) => ({
    source: x.source,
    error: x.error,
  })),
}, null, 2));

process.exit(best ? 0 : 1);
