import { hostname } from 'node:os';
import { readWelesRecord } from '../_shared/skarbiec_accounts.mjs';

const DATABASE_URL = process.env.WELES_DATABASE_URL || '';
const DATABASE_TOKEN = process.env.WELES_DATABASE_TOKEN || '';
const trajectoryId = process.env.GENERIC_SAVED_TRAJECTORY_ID || '';

const trajectoryItem = process.env.GENERIC_SAVED_TRAJECTORY_ITEM || '';

function headers() {
  return { apikey: DATABASE_TOKEN, Authorization: `Bearer ${DATABASE_TOKEN}`, 'content-type': 'application/json' };
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function setJsonEnv(name, value) {
  if (isObject(value)) process.env[name] = JSON.stringify(value);
}

function replaySteps(definition) {
  const replay = Array.isArray(definition.replay) ? definition.replay : Array.isArray(definition.steps) ? definition.steps : [];
  const steps = [];
  for (const raw of replay) {
    if (!isObject(raw) || typeof raw.tool !== 'string' || !raw.tool) continue;
    steps.push({
      tool: raw.tool,
      args: isObject(raw.args) ? raw.args : {},
      ...(typeof raw.result === 'string' ? { result: raw.result } : {}),
    });
  }
  return steps;
}

let row;
let trajectoryReference;
if (trajectoryItem) {
  const document = readWelesRecord(trajectoryItem);
  if (document.context?.status !== 'active') throw new Error(`saved trajectory is not active: ${trajectoryItem}`);
  const fields = document.fields ?? {};
  row = {
    id: trajectoryItem,
    name: document.context?.display_name ?? trajectoryItem,
    url: fields.url ?? '',
    objective: fields.objective ?? '',
    definition: fields.definition_json ? JSON.parse(fields.definition_json) : {},
    execution_host: fields.execution_host ?? document.context?.execution_host ?? null,
  };
  trajectoryReference = trajectoryItem;
} else {
  if (!DATABASE_URL || !DATABASE_TOKEN) throw new Error('WELES_DATABASE_URL and WELES_DATABASE_TOKEN required');
  if (!trajectoryId) throw new Error('GENERIC_SAVED_TRAJECTORY_ID or GENERIC_SAVED_TRAJECTORY_ITEM required');
  const res = await fetch(`${DATABASE_URL}/rest/v1/weles_trajectories?id=eq.${encodeURIComponent(trajectoryId)}&status=eq.active&select=id,name,action,url,objective,definition,execution_host`, { headers: headers() });
  if (!res.ok) throw new Error(`load saved trajectory HTTP ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  row = rows[0];
  if (!row) throw new Error(`saved trajectory not found: ${trajectoryId}`);
  trajectoryReference = trajectoryId;
}
const definition = isObject(row.definition) ? row.definition : {};
if (row.execution_host) {
  const expectedHost = String(row.execution_host).trim().toLowerCase().replace(/\.+$/, '');
  const actualHost = hostname().trim().toLowerCase().replace(/\.+$/, '');
  if (expectedHost !== actualHost) {
    throw new Error(`saved trajectory ${trajectoryReference} is bound to managed host ${expectedHost}; refusing execution on ${actualHost}`);
  }
}

process.env.GENERIC_TASK_LABEL = definition.session_label ? String(definition.session_label) : 'generic_saved_task';
process.env.GENERIC_TASK_URL = String(definition.url || row.url || '');
process.env.GENERIC_TASK_OBJECTIVE = String(definition.objective || row.objective || '');
if (definition.flow_name) process.env.GENERIC_TASK_FLOW_NAME = String(definition.flow_name);
else process.env.GENERIC_TASK_FLOW_NAME = `saved:${row.id}`;
if (definition.proxy) process.env.GENERIC_TASK_PROXY = String(definition.proxy);
if (definition.headless === true) process.env.GENERIC_TASK_HEADLESS = '1';
if (definition.browser) process.env.GENERIC_TASK_BROWSER = String(definition.browser);
if (definition.os) process.env.GENERIC_TASK_OS = String(definition.os);
if (definition.locale) process.env.GENERIC_TASK_LOCALE = String(definition.locale);
setJsonEnv('GENERIC_TASK_CONSTRAINTS', definition.constraints);
setJsonEnv('GENERIC_TASK_ENV', definition.env);
const replay = replaySteps(definition);
if (replay.length === 0) throw new Error(`saved trajectory ${trajectoryReference} has no replay steps`);
process.env.GENERIC_TASK_REPLAY = JSON.stringify(replay);
process.env.GENERIC_TASK_REPLAY_ONLY = '1';
process.env.GENERIC_TASK_SKIP_SAVED_FLOW_REPLAY = '1';

console.log(`[saved-task] ${row.name} (${row.id}) -> ${process.env.GENERIC_TASK_URL}`);
await import('./browser_task.mjs');
