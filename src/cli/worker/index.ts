import type { ParsedCli } from '../../cli.js';
import { printAnswer, UsageError } from '../usage.js';
import { operatorJson, welesOperatorConnection } from '../../runtime/api/connection.js';
import protocol from '../../worker/weles-api-server/worker-control/actions.json';

type WorkerAction = keyof typeof protocol.mutates;
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
  // An action that changes the dispatcher is a POST; a reading is a GET.
  const mutates = protocol.mutates[action];
  const connection = welesOperatorConnection(`/worker/${action}`);
  try {
    const response = await connection.fetch(connection.endpoint, {
      method: mutates ? 'POST' : 'GET',
      headers: connection.headers,
      redirect: 'error',
    });
    const body = await operatorJson(response);
    const result = { ...body, ok: body.ok === true, operation: action, endpoint: connection.endpoint.toString(), http_status: response.status };
    try {
      if (typeof body.ok !== 'boolean') throw new Error(`HTTP ${response.status}: invalid worker response`);
      if (response.ok && body.ok && action === 'version') {
        const identity = body.identity;
        if (!object(identity) || identity.source !== 'weles-worker'
            || typeof identity.instance_id !== 'string' || identity.instance_id.length === 0
            || !object(identity.runner) || !Number.isSafeInteger(identity.runner.pid) || Number(identity.runner.pid) <= 0) {
          throw new Error('the endpoint did not report a Weles process identity');
        }
      } else if (response.ok && body.ok) {
        const state = checkedState(mutates ? body.after : body.worker);
        if (mutates && checkedState(body.before).pid !== state.pid) {
          throw new Error('worker control replaced the service process');
        }
      }
    } catch (cause) {
      return {
        ...result,
        ok: false,
        error: 'worker_contract_invalid',
        message: cause instanceof Error ? cause.message : String(cause),
        observed_response: body,
      };
    }
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`worker ${action} ${connection.endpoint}: ${message}`, { cause });
  }
}

export async function runWorker(parsed: ParsedCli): Promise<void> {
  const [action] = parsed.positional;
  if (parsed.positional.length !== 1 || !Object.hasOwn(protocol.mutates, action)
      || Object.keys(parsed.options).some(key => key !== 'json')) {
    throw new UsageError(`worker requires ${Object.keys(protocol.mutates).join(', ')}; only --json is accepted`);
  }
  // Check the resident contract before an older endpoint can interpret a
  // control request as permission to recreate the retired native worker.
  const mutates = protocol.mutates[action as WorkerAction];
  let result = await request(mutates ? 'status' : action as WorkerAction);
  if (result.http_status < 400 && result.ok && mutates) {
    result = await request(action as WorkerAction);
  }
  printAnswer(result, parsed.options.json === true);
  if (result.http_status >= 400 || !result.ok) process.exitCode = 1;
}
