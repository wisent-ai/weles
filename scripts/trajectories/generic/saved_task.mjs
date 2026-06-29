const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const trajectoryId = process.env.GENERIC_SAVED_TRAJECTORY_ID || '';

function headers() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json' };
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function setJsonEnv(name, value) {
  if (isObject(value)) process.env[name] = JSON.stringify(value);
}

if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
if (!trajectoryId) throw new Error('GENERIC_SAVED_TRAJECTORY_ID required');

const res = await fetch(`${SUPABASE_URL}/rest/v1/weles_trajectories?id=eq.${encodeURIComponent(trajectoryId)}&status=eq.active&select=id,name,action,url,objective,definition`, { headers: headers() });
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
if (definition.max_steps != null) process.env.GENERIC_TASK_MAX_STEPS = String(definition.max_steps);
if (definition.proxy) process.env.GENERIC_TASK_PROXY = String(definition.proxy);
if (definition.headless === true) process.env.GENERIC_TASK_HEADLESS = '1';
setJsonEnv('GENERIC_TASK_CONSTRAINTS', definition.constraints);
setJsonEnv('GENERIC_TASK_ENV', definition.env);

console.log(`[saved-task] ${row.name} (${row.id}) -> ${process.env.GENERIC_TASK_URL}`);
await import('./browser_task.mjs');
