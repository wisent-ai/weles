import { readWelesRecord } from '../_shared/skarbiec_accounts.mjs';

const trajectoryItem = process.env.GENERIC_SAVED_TRAJECTORY_ITEM || '';

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

if (!trajectoryItem) throw new Error('GENERIC_SAVED_TRAJECTORY_ITEM required');
const document = readWelesRecord(trajectoryItem);
if (document.context?.status !== 'active') throw new Error(`saved trajectory is not active: ${trajectoryItem}`);
const fields = document.fields ?? {};
const row = {
  id: trajectoryItem,
  name: document.context?.display_name ?? trajectoryItem,
  url: fields.url ?? '',
  objective: fields.objective ?? '',
  definition: fields.definition_json ? JSON.parse(fields.definition_json) : {},
};
const definition = isObject(row.definition) ? row.definition : {};

process.env.GENERIC_TASK_LABEL = 'generic_saved_task';
process.env.GENERIC_TASK_URL = String(definition.url || row.url || '');
process.env.GENERIC_TASK_OBJECTIVE = String(definition.objective || row.objective || '');
if (definition.flow_name) process.env.GENERIC_TASK_FLOW_NAME = String(definition.flow_name);
else process.env.GENERIC_TASK_FLOW_NAME = `saved:${row.id}`;
if (definition.proxy) process.env.GENERIC_TASK_PROXY = String(definition.proxy);
if (definition.headless === true) process.env.GENERIC_TASK_HEADLESS = '1';
setJsonEnv('GENERIC_TASK_CONSTRAINTS', definition.constraints);
setJsonEnv('GENERIC_TASK_ENV', definition.env);
const replay = replaySteps(definition);
if (replay.length === 0) throw new Error(`saved trajectory ${trajectoryItem} has no replay steps`);
process.env.GENERIC_TASK_REPLAY = JSON.stringify(replay);
process.env.GENERIC_TASK_REPLAY_ONLY = '1';
process.env.GENERIC_TASK_SKIP_SAVED_FLOW_REPLAY = '1';

console.log(`[saved-task] ${row.name} (${row.id}) -> ${process.env.GENERIC_TASK_URL}`);
await import('./browser_task.mjs');
