import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeError } from '../../_shared/error-chain/index.cjs';
import { DeclaredError } from '../../errors/index.cjs';
import { causes } from '../../errors/operations/executor.cjs';
import { causes as signin } from '../../errors/operations/sign-in.cjs';
import { welesOperatorConnection, type WelesApiOptions } from './connection.js';

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

/** The executor's answer to one status: which declared cause a refusal is. */
function statusCause(status: number) {
  if (status === 401 || status === 403) return causes.UNAUTHORIZED;
  if (status === 404) return causes.NOT_FOUND;
  if (status >= 500) return causes.FAILED;
  return causes.REFUSED;
}

/**
 * One exchange with the executor: its JSON answer, or the declared cause of
 * what went wrong between this shell and that answer. The executor's own
 * words travel whole as the observed state.
 */
async function exchange(
  path: string,
  method: 'GET' | 'POST',
  body: string | undefined,
  operation: string,
  options: WelesApiOptions,
) {
  const connection = welesOperatorConnection(path, options);
  const where = { operation, endpoint: connection.endpoint.href };
  let response: Response;
  let text: string;
  try {
    response = await connection.fetch(connection.endpoint, {
      method,
      headers: connection.headers,
      redirect: 'error',
      body,
    });
    text = await response.text();
  } catch (error) {
    throw new DeclaredError(
      causes.UNREACHABLE,
      { ...where, answer: describeError(error) },
      { cause: error },
    );
  }
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch (error) {
    const type = response.headers.get('content-type') ?? 'no content type';
    throw new DeclaredError(
      response.ok ? causes.ANSWER_NOT_JSON : statusCause(response.status),
      {
        ...where,
        status: response.status,
        answer: `HTTP ${response.status} (${type}) ${text.trim() ? JSON.stringify(text.trim()) : 'with an empty body'}, not JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
      { cause: error },
    );
  }
  const record =
    answer && typeof answer === 'object' && !Array.isArray(answer)
      ? (answer as Record<string, unknown>)
      : null;
  if (!response.ok)
    throw new DeclaredError(statusCause(response.status), {
      ...where,
      status: response.status,
      answer: optionalText(record?.error) ?? text.trim(),
    });
  if (!record)
    throw new DeclaredError(causes.ANSWER_NOT_JSON, {
      ...where,
      answer: `HTTP ${response.status} answered ${text.trim()}, JSON that is not an object`,
    });
  return record;
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
  const placement = await import(pathToFileURL(PLACEMENT_MODULE).href).catch(
    (error: unknown) => {
      throw new DeclaredError(
        signin.INSTALL_INCOMPLETE,
        { module: PLACEMENT_MODULE, answer: describeError(error) },
        { cause: error },
      );
    },
  );
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
  if (answer.ok !== true || typeof answer.detached_run !== 'string')
    throw new DeclaredError(signin.RUN_NOT_STARTED, {
      action,
      answer: JSON.stringify(answer),
    });
  return answer.detached_run;
}

/** Read a started Apple run back. */
export async function readAppleRun(
  runId: string,
  options: WelesApiOptions = {},
): Promise<AppleRun> {
  const id = runId.trim();
  if (!id) throw new DeclaredError(signin.RUN_ID_MISSING);
  const answer = await exchange(
    `/diagnostics/${encodeURIComponent(id)}/file?path=run-result.json`,
    'GET',
    undefined,
    'read_apple_run_result',
    options,
  );
  if (typeof answer.status !== 'string')
    throw new DeclaredError(signin.RUN_RESULT_UNREADABLE, {
      run: id,
      answer: JSON.stringify(answer),
    });
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
