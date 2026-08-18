#!/usr/bin/env node
// Cancel provider topup rows auto-enqueued by proxy 407 recovery during local
// diagnostic scans. Does not delete rows; marks them failed with a clear error.

import { existsSync, readFileSync } from 'node:fs';

function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}

loadDotEnv();

const url = process.env.WELES_SUPABASE_URL || '';
const key = process.env.WELES_SUPABASE_SERVICE_ROLE_KEY || '';
if (!url || !key) throw new Error('Supabase env missing');

const actions = process.argv.slice(2).filter(Boolean);
const targetActions = actions.length ? actions : ['iproyal_topup', 'pingproxies_topup', 'brightdata_topup'];
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const cancelled = [];
for (const action of targetActions) {
  const rowsRes = await fetch(`${url}/rest/v1/account_action_logs?action=eq.${encodeURIComponent(action)}&status=eq.queued&select=id,action,status,started_at,scheduled_at,params&order=scheduled_at.desc&limit=25`, { headers });
  if (!rowsRes.ok) throw new Error(`${action} list HTTP ${rowsRes.status}: ${await rowsRes.text()}`);
  const rows = await rowsRes.json();
  for (const row of rows) {
    const params = row.params && typeof row.params === 'object' ? row.params : {};
    const batch = String(params.batch || '');
    if (batch !== 'auto-407-recovery') continue;
    const patch = {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: 'cancelled local diagnostic auto-407 topup enqueue; user did not approve purchase',
      result: {
        cancelled: true,
        cancelled_by: 'scripts/debug/cancel_recent_auto_topups.mjs',
        reason: 'local diagnostic scan side effect',
      },
    };
    const patchRes = await fetch(`${url}/rest/v1/account_action_logs?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    if (!patchRes.ok) throw new Error(`${row.id} patch HTTP ${patchRes.status}: ${await patchRes.text()}`);
    cancelled.push({ id: row.id, action: row.action, started_at: row.started_at, scheduled_at: row.scheduled_at });
  }
}

console.log(JSON.stringify({ ok: true, cancelled }, null, 2));
