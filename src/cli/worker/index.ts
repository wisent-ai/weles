import type { ParsedCli } from '../../cli.js';
import { welesOperatorConnection } from '../../runtime/api/connection.js';
import protocol from '../../worker/weles-api-server/worker-control/actions.json';

type WorkerAction = keyof typeof protocol.actions;
type Document = Record<string, unknown>;

function object(value: unknown): value is Document {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkedState(value: unknown): Document {
  if (!object(value) || value.schema !== 'weles.worker-status.v1'
      || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || typeof value.running !== 'boolean' || typeof value.ready !== 'boolean'
      || typeof value.state !== 'string' || !object(value.dispatcher)) {
    throw new Error('the endpoint did not report a resident Weles worker; no legacy worker control is permitted');
  }
  return value;
}

async function request(action: WorkerAction) {
  const declaration = protocol.actions[action];
  const connection = welesOperatorConnection(`/worker/${action}`);
  try {
    const response = await connection.fetch(connection.endpoint, {
      method: declaration.method,
      headers: connection.headers,
      redirect: 'error',
    });
    const body: unknown = await response.json();
    if (!object(body) || typeof body.ok !== 'boolean') throw new Error('invalid worker response');
    if (response.ok && body.ok) {
      const state = checkedState(declaration.mutation ? body.after : body.worker);
      if (declaration.mutation && checkedState(body.before).pid !== state.pid) {
        throw new Error('worker control replaced the service process');
      }
    }
    return { ...body, ok: body.ok, operation: action, endpoint: connection.endpoint.toString(), http_status: response.status };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`worker ${action} ${connection.endpoint}: ${message}`, { cause });
  }
}

export async function runWorker(parsed: ParsedCli): Promise<void> {
  const [action] = parsed.positional;
  if (parsed.positional.length !== 1 || !Object.hasOwn(protocol.actions, action)
      || Object.keys(parsed.options).some(key => key !== 'json')) {
    throw new Error(`worker requires ${Object.keys(protocol.actions).join(', ')}; only --json is accepted`);
  }
  // Check the resident contract before an older endpoint can interpret a
  // control request as permission to recreate the retired native worker.
  let result = await request('status');
  if (result.http_status < 400 && result.ok && protocol.actions[action as WorkerAction].mutation) {
    result = await request(action as WorkerAction);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.http_status >= 400 || !result.ok) process.exitCode = 1;
}
