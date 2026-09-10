// The GENERIC_TASK_* environment a queued generic task arrives as, read into
// the shapes browser_task.mjs runs on.

/** The named variable when it is a non-empty string, else `otherwise`. */
export function envString(name, otherwise = '') {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : otherwise;
}

/** The named variable parsed as JSON; `otherwise` when it is absent or not JSON. */
export function parseJsonEnv(name, otherwise) {
  const raw = process.env[name];
  if (!raw) return otherwise;
  try { return JSON.parse(raw); } catch { return otherwise; }
}

/** The task URL, which has to be an absolute http(s) URL. */
export function requireHttpUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('GENERIC_TASK_URL must be a valid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('GENERIC_TASK_URL must be http(s)');
  return parsed.toString();
}

/** Only UPPER_SNAKE keys with scalar values survive into the task's env hints. */
export function safeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw);
  }
  return out;
}

/** A replay is a list of {tool, args, result?} steps; anything else is no replay. */
export function normalizedReplay(value) {
  if (!Array.isArray(value)) return null;
  const steps = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const tool = typeof raw.tool === 'string' ? raw.tool : '';
    if (!tool) continue;
    const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {};
    const step = { tool, args };
    if (typeof raw.result === 'string') step.result = raw.result;
    steps.push(step);
  }
  return steps.length > 0 ? steps : null;
}
