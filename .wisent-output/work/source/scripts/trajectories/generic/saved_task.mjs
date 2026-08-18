const DATABASE_URL = process.env.WELES_DATABASE_URL || '';
const DATABASE_TOKEN = process.env.WELES_DATABASE_TOKEN || '';
const trajectoryId = process.env.GENERIC_SAVED_TRAJECTORY_ID || '';

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

if (!DATABASE_URL || !DATABASE_TOKEN) throw new Error('WELES_DATABASE_URL and WELES_DATABASE_TOKEN required');
if (!trajectoryId) throw new Error('GENERIC_SAVED_TRAJECTORY_ID required');

const res = await fetch(`${DATABASE_URL}/rest/v1/weles_trajectories?id=eq.${encodeURIComponent(trajectoryId)}&status=eq.active&select=id,name,action,url,objective,definition`, { headers: headers() });
if (!res.ok) throw new Error(`load saved trajectory HTTP ${res.status}: ${await res.text()}`);
const rows = await res.json();
const row = rows[0];
if (!row) throw new Error(`saved trajectory not found: ${trajectoryId}`);
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
if (replay.length === 0) throw new Error(`saved trajectory ${trajectoryId} has no replay steps`);
process.env.GENERIC_TASK_REPLAY = JSON.stringify(replay);
process.env.GENERIC_TASK_REPLAY_ONLY = '1';
process.env.GENERIC_TASK_SKIP_SAVED_FLOW_REPLAY = '1';

console.log(`[saved-task] ${row.name} (${row.id}) -> ${process.env.GENERIC_TASK_URL}`);
await import('./browser_task.mjs');
