#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const LIMIT = 60;

function parseEnv(text) {
  const values = {};
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function loadEnvironment(repositoryRoot) {
  const candidates = [
    process.env.WELES_WORKER_ENV_FILE,
    join(repositoryRoot, '.config', 'weles', 'worker.env'),
    join(homedir(), '.config', 'weles', 'worker.env'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return { ...parseEnv(await readFile(candidate, 'utf8')), ...process.env };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Weles worker environment is unavailable');
}

function titleCase(value) {
  return value
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function resultState(status, healthy) {
  if (healthy === true || ['running', 'completed', 'approved'].includes(status)) return 'available';
  if (healthy === false || ['failed', 'rejected', 'cancelled', 'pending_review'].includes(status)) return 'attention';
  return 'unavailable';
}

function executionHost(claimedBy) {
  if (typeof claimedBy !== 'string' || !claimedBy) return null;
  return claimedBy.replace(/^weles-/, '').replace(/-\d+$/, '');
}

function timestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const parsed = new Date(zoned);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stages(row) {
  return [
    ['Scheduled', 'queued', row.scheduled_at],
    ['Claimed', 'claimed', row.claimed_at],
    ['Started', row.status === 'running' ? 'running' : 'completed', row.started_at],
    ['Finished', row.status, row.completed_at],
  ].map(([name, status, recordedAt], index) => ({
    id: `${row.id}-${index}`,
    name,
    status,
    recorded_at: timestamp(recordedAt),
  })).filter(({ recorded_at: recordedAt }) => recordedAt !== null);
}

function artifactInventory(row) {
  const artifacts = row.result?.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return [];
  const kinds = {
    screenshots: ['screenshot', 'screenshot'],
    videos: ['video-recording', 'video'],
    dom: ['page-capture', 'pageCapture'],
    logs: ['log', 'log'],
  };
  const records = [];
  for (const [key, [title, kind]] of Object.entries(kinds)) {
    const value = artifacts[key];
    const count = Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0;
    for (let index = 0; index < count; index += 1) {
      records.push({ id: `${row.id}-${key}-${index + 1}`, title: `${title}-${index + 1}`, kind });
    }
  }
  return records;
}

function sanitizeRow(row) {
  const signal = typeof row.result?.ban_signal?.signal === 'string'
    ? row.result.ban_signal.signal
    : row.status;
  const healthy = typeof row.result?.ban_signal?.healthy === 'boolean'
    ? row.result.ban_signal.healthy
    : null;
  return {
    id: row.id,
    run_label: `run-${row.id.slice(0, 8)}`,
    action: row.action,
    platform: row.platform,
    status: row.status,
    execution_host: executionHost(row.claimed_by),
    recorded_at: timestamp(row.completed_at ?? row.started_at ?? row.claimed_at ?? row.scheduled_at),
    result: {
      state: resultState(row.status, healthy),
      title: titleCase(row.status),
      signal,
    },
    stages: stages(row),
    artifacts: artifactInventory(row),
  };
}

const repositoryRoot = resolve(process.argv[2] ?? process.cwd());
const env = await loadEnvironment(repositoryRoot);
const baseUrl = (env.WELES_DATABASE_URL ?? '').replace(/\/$/, '');
const token = env.WELES_DATABASE_TOKEN ?? '';
if (!baseUrl || !token) throw new Error('Weles managed-run credentials are unavailable');

const columns = 'id,action,platform,status,result,started_at,completed_at,claimed_at,claimed_by,scheduled_at';
const endpoint = new URL(`${baseUrl}/rest/v1/account_action_logs`);
endpoint.searchParams.set('select', columns);
endpoint.searchParams.set('order', 'claimed_at.desc.nullslast');
endpoint.searchParams.set('limit', String(LIMIT));
const response = await fetch(endpoint, {
  headers: { apikey: token, Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Weles managed-run read failed (${response.status})`);
const rows = await response.json();
if (!Array.isArray(rows)) throw new Error('Weles managed-run response is not an array');
process.stdout.write(`${JSON.stringify({ source: 'managed_queue', runs: rows.map(sanitizeRow) })}\n`);
