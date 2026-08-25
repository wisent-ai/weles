#!/usr/bin/env node
// Cancel exact Stado jobs created by an accidental diagnostic top-up request.
// Usage: node scripts/debug/cancel_recent_auto_topups.mjs <job-id>...
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';


const jobIds = process.argv.slice(2).filter((id) => /^[0-9a-f]{8}$/i.test(id));
if (!jobIds.length) throw new Error('at least one exact Stado job id is required');
const stado = process.env.WELES_STADO_BIN || join(homedir(), '.stado', 'bin', 'stado');
const cancelled = [];
for (const id of jobIds) {
  const result = spawnSync(stado, ['cancel', id], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Stado refused cancellation of ${id}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  cancelled.push(id);
}
console.log(JSON.stringify({ ok: true, cancelled }, null, 2));
