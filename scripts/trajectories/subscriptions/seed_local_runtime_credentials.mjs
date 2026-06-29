// Seed model-router runtime subscriptions from already-authenticated local CLIs.
//
// This does not run browser login trajectories. It reads:
//   - Claude Code OAuth blob from macOS Keychain service "Claude Code-credentials"
//   - Codex auth JSON from ~/.codex/auth.json
//   - Kimi Code OAuth JSON from ~/.kimi-code/credentials/kimi-code.json
//
// Config comes from Weles service_credentials metadata
// id='codex-reauth-config' with fallback to 'claude-reauth-config'.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function die(message) {
  console.error(message);
  process.exit(1);
}

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function sbGet(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) die('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

async function loadRouterConfig() {
  const rows = await sbGet(
    'service_credentials?id=in.(codex-reauth-config,claude-reauth-config)&select=id,metadata'
  );
  const configs = new Map(rows.map((row) => [row.id, row.metadata || {}]));
  const meta = configs.get('codex-reauth-config') || configs.get('claude-reauth-config');
  if (!meta) throw new Error('missing codex-reauth-config / claude-reauth-config');
  for (const key of ['MODEL_ROUTER_URL', 'WISENT_APP_AGENT_ID', 'WISENT_DONOR_USER_ID']) {
    if (!meta[key]) throw new Error(`router config missing ${key}`);
  }
  return {
    routerUrl: String(meta.MODEL_ROUTER_URL).replace(/\/+$/, ''),
    agentId: String(meta.WISENT_APP_AGENT_ID),
    donorUserId: String(meta.WISENT_DONOR_USER_ID),
  };
}

function readJsonFile(path, validate) {
  if (!existsSync(path)) throw new Error(`missing file: ${path}`);
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  validate(parsed);
  return raw;
}

function readClaudeKeychain() {
  const result = spawnSync('security', [
    'find-generic-password',
    '-s',
    'Claude Code-credentials',
    '-w',
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Claude Keychain read failed: ${String(result.stderr || '').trim()}`);
  }
  const raw = String(result.stdout || '').trim();
  const parsed = JSON.parse(raw);
  if (!parsed?.claudeAiOauth?.accessToken) {
    throw new Error('Claude Keychain secret is not a claudeAiOauth blob');
  }
  return raw;
}

function readCodexAuth() {
  return readJsonFile(process.env.CODEX_AUTH_PATH || join(homedir(), '.codex', 'auth.json'), (parsed) => {
    if (!parsed?.tokens?.refresh_token && !parsed?.tokens?.id_token && parsed?.auth_mode !== 'chatgpt') {
      throw new Error('Codex auth JSON does not look like a ChatGPT auth blob');
    }
  });
}

function readKimiAuth() {
  return readJsonFile(process.env.KIMI_AUTH_PATH || join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json'), (parsed) => {
    if (!parsed?.access_token || !parsed?.refresh_token) {
      throw new Error('Kimi credentials JSON missing access_token / refresh_token');
    }
  });
}

async function listActiveSubscriptions(cfg) {
  const res = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`list model-router subscriptions -> ${res.status} ${text}`);
  return JSON.parse(text).subscriptions || [];
}

async function donate(cfg, provider, label, apiKey) {
  const res = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: cfg.donorUserId,
      provider,
      label,
      api_key: apiKey,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`donate ${provider} -> ${res.status} ${text}`);
  return JSON.parse(text).subscription || {};
}

async function revoke(cfg, subscriptionId) {
  const res = await fetch(`${cfg.routerUrl}/v1/subscriptions/${cfg.agentId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: cfg.donorUserId,
      subscription_id: subscriptionId,
    }),
  });
  return res.status < 400;
}

function selectedProviders() {
  const arg = process.argv.find((item) => item.startsWith('--providers='));
  if (!arg) return new Set(['claude_code', 'codex', 'kimi']);
  return new Set(arg.slice('--providers='.length).split(',').map((item) => item.trim()).filter(Boolean));
}

async function main() {
  const cfg = await loadRouterConfig();
  const providers = selectedProviders();
  const credentials = [];
  if (providers.has('claude_code')) {
    credentials.push({
      provider: 'claude_code',
      label: `local-cli-seed claude keychain ${new Date().toISOString()}`,
      apiKey: readClaudeKeychain(),
      source: 'macos-keychain',
    });
  }
  if (providers.has('codex')) {
    credentials.push({
      provider: 'codex',
      label: `local-cli-seed codex auth-json ${new Date().toISOString()}`,
      apiKey: readCodexAuth(),
      source: process.env.CODEX_AUTH_PATH || '~/.codex/auth.json',
    });
  }
  if (providers.has('kimi')) {
    credentials.push({
      provider: 'kimi',
      label: `local-cli-seed kimi credentials-json ${new Date().toISOString()}`,
      apiKey: readKimiAuth(),
      source: process.env.KIMI_AUTH_PATH || '~/.kimi-code/credentials/kimi-code.json',
    });
  }

  const before = await listActiveSubscriptions(cfg);
  const results = [];
  for (const credential of credentials) {
    const activeBefore = before.filter((sub) => sub.provider === credential.provider);
    const inserted = await donate(cfg, credential.provider, credential.label, credential.apiKey);
    let revoked = 0;
    for (const old of activeBefore) {
      if (old.id && await revoke(cfg, old.id)) revoked += 1;
    }
    results.push({
      provider: credential.provider,
      source: credential.source,
      insertedId: inserted.id || null,
      revokedActiveRows: revoked,
      previousActiveRows: activeBefore.length,
      label: credential.label,
    });
  }
  console.log(JSON.stringify({
    ok: true,
    routerUrl: cfg.routerUrl,
    agentId: cfg.agentId,
    results,
  }, null, 2));
}

main().catch((error) => {
  die(error.stack || error.message || String(error));
});
