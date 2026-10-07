import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  operatorJson,
  welesOperatorConnection,
  type WelesApiOptions,
} from './connection.js';

// The Apple trajectories (apple_login, apple_create_developer_id) start only
// with a guard id, the execution host and agent, and three one-use capabilities
// Stado mints on that host. This module issues them and starts and reads the
// runs on the managed executor.

const SECONDS_PER_MINUTE = 60;
// The capability issuer is the .mjs module the Apple trajectories import from
// src/auth; it sits outside the TypeScript rootDir's compiled tree, so it is
// loaded by its path in the installed release rather than a static import.
const PLACEMENT_MODULE = join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'auth',
  'apple-account-placement.mjs',
);

/** The authorization one Apple run carries. */
export type AppleAuthorization = {
  accountRole: string;
  guardId: string;
  executionHost: string;
  executionAgent: string;
  capabilities: unknown;
};

/** One Apple run as the managed executor records it. */
export type AppleRun = {
  id: string;
  status: string;
  ok: boolean | null;
  stdout: string | null;
  error: string | null;
};

async function exchange(
  path: string,
  method: 'GET' | 'POST',
  body: string | undefined,
  operation: string,
  options: WelesApiOptions,
) {
  const connection = welesOperatorConnection(path, options);
  try {
    const response = await connection.fetch(connection.endpoint, {
      method,
      headers: connection.headers,
      redirect: 'error',
      body,
    });
    const answer = await operatorJson(response);
    if (!response.ok) {
      throw new Error(
        [`HTTP ${response.status}`, optionalText(answer.error)]
          .filter(Boolean)
          .join(': '),
      );
    }
    return answer;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${operation} ${connection.endpoint}: ${error}`, { cause });
  }
}

function optionalText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

/** A new guard id and the three one-use capabilities Stado mints for it on the execution host. */
export async function issueAppleAuthorization(
  accountRole: string,
  executionHost: string,
  executionAgent: string,
  expiryMinutes: number,
): Promise<AppleAuthorization> {
  const guardId = randomUUID();
  const placement = await import(pathToFileURL(PLACEMENT_MODULE).href);
  const capabilities = placement.issueAppleLoginCapabilities({
    executionHost,
    executionAgent,
    authorizationId: guardId,
    ttlSeconds: expiryMinutes * SECONDS_PER_MINUTE,
  });
  return { accountRole, guardId, executionHost, executionAgent, capabilities };
}

/** Start one Apple action detached on the managed executor; the answer is its run id. */
export async function startAppleRun(
  action: 'apple_login' | 'apple_create_developer_id',
  authorization: AppleAuthorization,
  extraParams: Record<string, string>,
  options: WelesApiOptions = {},
): Promise<string> {
  const answer = await exchange(
    '/run',
    'POST',
    JSON.stringify({
      action,
      params: {
        login_role: authorization.accountRole,
        apple_auth_guard_id: authorization.guardId,
        apple_execution_host: authorization.executionHost,
        apple_execution_agent: authorization.executionAgent,
        apple_login_capabilities: authorization.capabilities,
        ...extraParams,
      },
      detached: true,
    }),
    `submit_${action}`,
    options,
  );
  if (answer.ok !== true || typeof answer.detached_run !== 'string') {
    throw new Error(`submit_${action}: Weles did not accept the run`);
  }
  return answer.detached_run;
}

/** Read a started Apple run back. */
export async function readAppleRun(
  runId: string,
  options: WelesApiOptions = {},
): Promise<AppleRun> {
  const id = runId.trim();
  if (!id) throw new Error('run_id_required');
  const answer = await exchange(
    `/diagnostics/${encodeURIComponent(id)}/file?path=run-result.json`,
    'GET',
    undefined,
    'read_apple_run_result',
    options,
  );
  if (typeof answer.status !== 'string') {
    throw new Error(
      `read_apple_run_result: run ${id} result carries no status`,
    );
  }
  let error = optionalText(answer.error);
  if (!error && answer.ok === false) error = optionalText(answer.stderr_tail);
  return {
    id,
    status: answer.status,
    ok: optionalBoolean(answer.ok),
    stdout: optionalText(answer.stdout),
    error,
  };
}
