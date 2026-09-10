import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// generic_saved_task replays one reviewed declaration. Two kinds reach here:
//
//   * a declared engagement — GENERIC_ENGAGEMENT plus the reviewed trajectory
//     the declaration names, both set by the dispatcher's admission step; and
//   * a saved trajectory definition, named by id or by vault item and replayed
//     step by step through browser_task.
//
// The engagement path is what replaced the 154 per-site interaction verbs.
// src/worker/deploy/weles-engagement-declaration.json is the only thing that
// says which reviewed trajectory an engagement replays, so nothing here maps a
// platform or a verb to a path: this file runs what admission already
// authorized, or it runs nothing.

const engagement = process.env.GENERIC_ENGAGEMENT || '';
const engagementTrajectory = process.env.GENERIC_ENGAGEMENT_TRAJECTORY || '';
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

if (engagement) {
  // Admission resolved the declaration before this process existed. If the
  // reviewed trajectory did not arrive with the engagement, the run refuses
  // rather than guessing a path from the engagement name.
  if (!engagementTrajectory) {
    throw new Error(`declared engagement ${engagement} reached execution without its reviewed trajectory`);
  }
  const repositoryRoot = process.env.WELES_REPO || resolve(import.meta.dirname, '..', '..', '..');
  console.log(`[saved-task] engagement ${engagement} -> ${engagementTrajectory}`);
  await import(pathToFileURL(join(repositoryRoot, engagementTrajectory)).href);
} else {
  let row;
  let trajectoryReference;
  if (trajectoryItem) {
    // Imported here, not at the top: reading a vault record resolves the
    // attested Skarbiec binary through Stado while the module loads, and a
    // declared engagement replays a reviewed trajectory without any of that.
    const { readWelesRecord } = await import('../_shared/skarbiec/accounts.mjs');
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
}
