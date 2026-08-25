#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.WELES_CRAWLER_HOST || '127.0.0.1';
const PORT = Number(process.env.WELES_CRAWLER_PORT || '8795');
const TOKEN = process.env.WELES_CRAWLER_TOKEN || process.env.WELES_API_TOKEN || '';
const BODY_LIMIT = Number(process.env.WELES_CRAWLER_BODY_LIMIT_BYTES || String(1024 * 1024));
const CAPTURE_TIMEOUT_MS = Number(process.env.WELES_CRAWLER_CAPTURE_TIMEOUT_MS || String(15 * 60 * 1000));
const STATE_DIR = process.env.WELES_CRAWLER_STATE_DIR || join(homedir(), '.stado', 'weles-crawler-runs');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = join(REPO, 'scripts', 'worker', 'stado-action-runner.mjs');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SAFE_ACCOUNT_ITEM = /^weles-[a-z0-9][a-z0-9-]{0,126}$/;
const CATEGORIES = new Set([
  'app-store-listing',
  'dashboard-console',
  'design-system',
  'documentation-site',
  'onboarding-auth',
  'pricing-page',
  'web-app',
]);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('WELES_CRAWLER_PORT is invalid');
if (!Number.isInteger(BODY_LIMIT) || BODY_LIMIT < 1024 || BODY_LIMIT > 16 * 1024 * 1024) throw new Error('WELES_CRAWLER_BODY_LIMIT_BYTES is invalid');
if (!Number.isInteger(CAPTURE_TIMEOUT_MS) || CAPTURE_TIMEOUT_MS < 1000) throw new Error('WELES_CRAWLER_CAPTURE_TIMEOUT_MS is invalid');
if (Buffer.byteLength(TOKEN) < 32) throw new Error('WELES_CRAWLER_TOKEN or WELES_API_TOKEN must be at least 32 bytes');
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

const queue = [];
let active = null;

function authorized(request) {
  const header = String(request.headers.authorization || '');
  const supplied = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : String(request.headers['x-api-key'] || '');
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(TOKEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function reply(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        rejectBody(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectBody(new Error('request body must be JSON'));
      }
    });
    request.on('error', rejectBody);
  });
}

function manifestPath(id) {
  return join(STATE_DIR, `${id}.json`);
}

function readManifest(id) {
  const path = manifestPath(id);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function writeManifest(manifest) {
  const path = manifestPath(manifest.crawl_id);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function normalizePlan(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('crawl plan must be an object');
  const crawlId = String(value.crawl_id || '');
  if (!SAFE_ID.test(crawlId)) throw new Error('crawl_id must match ^[a-z0-9][a-z0-9-]{0,127}$');
  const category = String(value.category || '');
  if (!CATEGORIES.has(category)) throw new Error(`unsupported crawl category: ${category}`);
  const accountItem = value.account_item ? String(value.account_item) : '';
  if (accountItem && !SAFE_ACCOUNT_ITEM.test(accountItem)) throw new Error('invalid Weles account item');
  if (!Array.isArray(value.captures) || value.captures.length < 1 || value.captures.length > 100) {
    throw new Error('captures must contain between 1 and 100 capture plans');
  }
  const captures = value.captures.map((capture, index) => {
    if (!capture || Array.isArray(capture) || typeof capture !== 'object') throw new Error(`captures[${index}] must be an object`);
    return {
      ...capture,
      site_id: String(capture.site_id || `${crawlId}-${String(index + 1).padStart(3, '0')}`),
      artifact_prefix: `stado://weles-captures/${crawlId}/${String(index + 1).padStart(3, '0')}/`,
    };
  });
  return { crawl_id: crawlId, category, account_item: accountItem, captures };
}

function runCapture(crawl, capture, index) {
  return new Promise((resolveRun) => {
    const payload = Buffer.from(JSON.stringify({
      action: 'generic_capture',
      accountItem: crawl.account_item || undefined,
      params: capture,
    }), 'utf8').toString('base64url');
    const child = spawn(process.execPath, [RUNNER, payload], {
      cwd: REPO,
      env: {
        ...process.env,
        WC_JOB_ID: `${crawl.crawl_id}-${String(index + 1).padStart(3, '0')}`,
        STADO_JOB_ID: `${crawl.crawl_id}-${String(index + 1).padStart(3, '0')}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), CAPTURE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      resolveRun({ ok: false, exit_code: null, signal: null, error: error.message });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        ok: code === 0 && !signal,
        exit_code: code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8').slice(-16 * 1024),
        stderr: Buffer.concat(stderr).toString('utf8').slice(-16 * 1024),
      });
    });
  });
}

async function execute(crawl) {
  const manifest = readManifest(crawl.crawl_id);
  manifest.status = 'running';
  manifest.started_at = new Date().toISOString();
  writeManifest(manifest);
  for (let index = 0; index < crawl.captures.length; index += 1) {
    const item = manifest.captures[index];
    item.status = 'running';
    item.started_at = new Date().toISOString();
    writeManifest(manifest);
    const result = await runCapture(crawl, crawl.captures[index], index);
    Object.assign(item, result, {
      status: result.ok ? 'completed' : 'failed',
      finished_at: new Date().toISOString(),
    });
    writeManifest(manifest);
    if (!result.ok) {
      manifest.status = 'failed';
      manifest.finished_at = new Date().toISOString();
      writeManifest(manifest);
      return;
    }
  }
  manifest.status = 'completed';
  manifest.finished_at = new Date().toISOString();
  writeManifest(manifest);
}

async function drain() {
  if (active || queue.length === 0) return;
  active = queue.shift();
  try {
    await execute(active);
  } catch (error) {
    const manifest = readManifest(active.crawl_id);
    if (manifest) {
      manifest.status = 'failed';
      manifest.error = error instanceof Error ? error.message : String(error);
      manifest.finished_at = new Date().toISOString();
      writeManifest(manifest);
    }
  } finally {
    active = null;
    setImmediate(drain);
  }
}

for (const file of readdirSync(STATE_DIR)) {
  if (!file.endsWith('.json')) continue;
  const path = join(STATE_DIR, file);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.status === 'queued' || manifest.status === 'running') {
    manifest.status = 'interrupted';
    manifest.finished_at = new Date().toISOString();
    writeManifest(manifest);
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
  if (request.method === 'GET' && url.pathname === '/healthz') {
    reply(response, 200, { ok: true, service: 'weles-crawler', version: VERSION, active: active?.crawl_id || null, queued: queue.length });
    return;
  }
  if (!authorized(request)) {
    reply(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/crawl') {
    try {
      const crawl = normalizePlan(await readJson(request));
      if (readManifest(crawl.crawl_id)) {
        reply(response, 409, { error: 'crawl_exists', crawl_id: crawl.crawl_id });
        return;
      }
      const manifest = {
        schema: 'weles.crawler-run.v1',
        crawl_id: crawl.crawl_id,
        category: crawl.category,
        status: 'queued',
        created_at: new Date().toISOString(),
        captures: crawl.captures.map((capture) => ({
          site_id: capture.site_id,
          source_url: capture.source_url,
          axis: capture.axis,
          artifact_prefix: capture.artifact_prefix,
          status: 'queued',
        })),
      };
      writeManifest(manifest);
      queue.push(crawl);
      setImmediate(drain);
      reply(response, 202, manifest);
    } catch (error) {
      reply(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const match = request.method === 'GET' ? url.pathname.match(/^\/crawl\/([a-z0-9][a-z0-9-]{0,127})$/) : null;
  if (match) {
    const manifest = readManifest(match[1]);
    reply(response, manifest ? 200 : 404, manifest || { error: 'crawl_not_found' });
    return;
  }
  reply(response, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[weles-crawler] listening http://${HOST}:${PORT} state=${STATE_DIR}`);
});
