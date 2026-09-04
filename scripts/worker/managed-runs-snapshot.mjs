#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
    const locators = Array.isArray(artifacts[key])
      ? artifacts[key].filter((entry) => typeof entry === 'string' && entry.startsWith('stado://weles/recordings/'))
      : [];
    for (let index = 0; index < locators.length; index += 1) {
      records.push({
        id: `${row.id}-${key}-${index + 1}`,
        title: `${title}-${index + 1}`,
        kind,
        delivery_kind: key,
        locator: locators[index],
      });
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

async function artifactDeliveryToken(repositoryRoot, env) {
  const configured = String(env.WELES_ARTIFACT_DELIVERY_TOKEN ?? '').trim();
  if (configured) return configured;

  const endpoint = env.WC_SKARBIEC_URL;
  const workloadId = env.SKARBIEC_WORKLOAD_ID;
  const signingKeyFile = env.SKARBIEC_WORKLOAD_SIGNING_KEY_FILE;
  if (!endpoint || !workloadId || !signingKeyFile) {
    throw new Error('Weles artifact delivery acquisition is unavailable');
  }

  const helper = join(repositoryRoot, 'scripts', 'worker', 'deploy', 'skarbiec-acquire.mjs');
  const scopes = join(repositoryRoot, 'scripts', 'worker', 'deploy', 'skarbiec-acquisition-scopes.conf');
  const { stdout } = await execFileAsync(process.execPath, [
    helper,
    scopes,
    'weles-artifact-delivery-token-bootstrap',
    'weles-artifact-delivery',
    'token',
  ], {
    encoding: 'utf8',
    env: {
      SKARBIEC_WORKLOAD_ID: workloadId,
      SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: signingKeyFile,
      WC_SKARBIEC_URL: endpoint,
    },
    maxBuffer: 8_192,
    timeout: 15_000,
  });
  const token = stdout.trim();
  if (Buffer.byteLength(token) < 32 || /\s/.test(token)) {
    throw new Error('Skarbiec returned an invalid artifact delivery credential');
  }
  return token;
}

async function signArtifact(repositoryRoot, deliveryKind, locator) {
  const allowedKinds = new Set(['screenshots', 'videos', 'dom', 'logs']);
  if (!allowedKinds.has(deliveryKind) || !locator.startsWith('stado://weles/recordings/')) {
    throw new Error('Managed artifact reference is invalid');
  }
  const env = await loadEnvironment(repositoryRoot);
  const baseUrl = new URL(env.WELES_DESKTOP_ARTIFACT_DELIVERY_URL ?? 'http://127.0.0.1:17615');
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(baseUrl.hostname);
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
      || (baseUrl.pathname !== '/' && baseUrl.pathname !== '')
      || (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && loopback))) {
    throw new Error('Weles artifact delivery endpoint is invalid');
  }
  const token = await artifactDeliveryToken(repositoryRoot, env);
  const artifacts = { screenshots: [], videos: [], dom: [], logs: [] };
  artifacts[deliveryKind].push(locator);
  const response = await fetch(new URL('/v1/artifacts/sign', baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    redirect: 'error',
    body: JSON.stringify({ artifacts }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Weles artifact signing failed (${response.status})`);
  const signedUrlText = payload?.artifacts?.[deliveryKind]?.[0];
  if (typeof signedUrlText !== 'string') {
    throw new Error('Weles artifact signing returned an invalid URL');
  }
  const signedUrl = new URL(signedUrlText);
  if (!['https:', 'http:'].includes(signedUrl.protocol)
      || signedUrl.username || signedUrl.password || !signedUrl.searchParams.has('signature')) {
    throw new Error('Weles artifact signing returned an invalid URL');
  }
  signedUrl.protocol = baseUrl.protocol;
  signedUrl.hostname = baseUrl.hostname;
  signedUrl.port = baseUrl.port;
  process.stdout.write(`${JSON.stringify({ url: signedUrl.href, expires_at: payload.expires_at })}\n`);
}

async function listManagedRuns(repositoryRoot) {
  const env = await loadEnvironment(repositoryRoot);
  const stado = env.WELES_STADO_BIN || join(homedir(), '.stado', 'bin', 'stado');
  const { stdout } = await execFileAsync(stado, ['status'], { env: { ...process.env, ...env } });
  const runs = String(stdout).split(/\r?\n/).slice(1).filter((line) => line.trim()).slice(0, LIMIT).map((line) => {
    const [id = '', status = '', host = '', ...command] = line.trim().split(/\s+/);
    return sanitizeRow({ id, status, claimed_by: host, action: command.join(' ') });
  });
  process.stdout.write(`${JSON.stringify({ source: 'stado', runs })}\n`);
}

if (process.argv[2] === '--sign') {
  await signArtifact(resolve(process.argv[3] ?? process.cwd()), process.argv[4] ?? '', process.argv[5] ?? '');
} else {
  await listManagedRuns(resolve(process.argv[2] ?? process.cwd()));
}
