// What Weles asks when Brama does not answer it: Stado's capability
// resolution (`stado capabilities resolve inference --consumer weles`), which
// proves Brama again and hands out the next alternative the operator
// declared — any OpenAI-compatible endpoint, its model and the role of the
// item holding its key — or refuses naming every alternative's product,
// route and cause. A run therefore stops only when no alternative answers,
// and then says by name what it could not reach; the report it makes lets
// Stado record the outage and show which alternative served Weles instead.
import { execFileSync } from 'node:child_process';
import type { ModelRouterConfig } from './router-config.js';

const CONSUMER = 'weles';
const FAMILY = 'inference';
const REPORTED = 'brama';

type Unreachable = { product: string; route: string; cause: string };

type Answer = {
  provider: string;
  route: string;
  model?: string | null;
  key_role?: string | null;
};

/** One Stado call's printed answer and, when it exited non-zero, why. */
type Ran = { stdout: string; refused?: string };

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function runStado(args: string[]): Ran {
  try {
    return {
      stdout: execFileSync('stado', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    // execFileSync's error carries the exit status and both streams.
    const exited = error as {
      status?: number | null;
      stdout?: unknown;
      stderr?: unknown;
    };
    if (typeof exited.status === 'number')
      return {
        stdout: String(exited.stdout ?? '').trim(),
        refused: `stado ${args.join(' ')} exited ${String(exited.status)}: ${String(exited.stderr ?? '').trim()}`,
      };
    throw new Error(
      `stado ${args.join(' ')} could not run: ${messageOf(error)}`,
      {
        cause: error,
      },
    );
  }
}

/** Every alternative a refusal envelope names, as one sentence. */
function named(printed: string): string | undefined {
  try {
    const envelope = JSON.parse(printed) as {
      details?: { unreachable?: Unreachable[] };
    };
    const items = envelope.details?.unreachable ?? [];
    const sentence = items
      .map((item) => `${item.product} at ${item.route}: ${item.cause}`)
      .join('; ');
    return sentence || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The route Weles asks instead of Brama, which did not answer it with
 * `cause`; `brama` is the configuration Brama was asked through, handed back
 * when Stado proves Brama answering again. `failed` reports Brama refused, so
 * Stado proves it again now instead of answering from its kept proof.
 */
export function insteadOfBrama(
  cause: string,
  brama: ModelRouterConfig,
  failed: boolean,
): ModelRouterConfig {
  const args = ['capabilities', 'resolve', FAMILY, '--consumer', CONSUMER];
  if (failed) args.push('--failed', REPORTED);
  args.push('--json');
  let ran: Ran;
  try {
    ran = runStado(args);
  } catch (error) {
    throw new Error(
      `Brama did not answer Weles (${cause}), and no alternative could be asked: ${messageOf(error)}`,
      { cause: error },
    );
  }
  if (ran.refused !== undefined)
    throw new Error(
      `Brama did not answer Weles (${cause}), and no inference alternative answers: ${named(ran.stdout) ?? ran.refused}`,
    );
  let answer: Answer;
  try {
    answer = JSON.parse(ran.stdout) as Answer;
  } catch (error) {
    throw new Error(
      `Brama did not answer Weles (${cause}); Stado's resolution printed no answer to read: ${ran.stdout.trim()}`,
      { cause: error },
    );
  }
  if (answer.provider === REPORTED) return brama;
  if (!answer.model)
    throw new Error(
      `Brama did not answer Weles (${cause}); ${answer.provider} at ${answer.route} answers in its place but declares no model: set capabilities.inference.endpoint.model`,
    );
  let key: string | undefined;
  if (answer.key_role) {
    const read = runStado([
      'credentials',
      'get',
      '--role',
      answer.key_role,
      '--field',
      'token',
    ]);
    if (read.refused !== undefined)
      throw new Error(
        `Brama did not answer Weles (${cause}); ${answer.provider} at ${answer.route} answers in its place, but the key of role ${answer.key_role} cannot be read: ${read.refused}`,
      );
    key = read.stdout.trim();
  }
  process.stderr.write(
    `Brama did not answer Weles (${cause}); asking ${answer.provider} at ${answer.route} for ${answer.model} in its place\n`,
  );
  return {
    routerUrl: answer.route.replace(/\/+$/, ''),
    ...(key ? { routerToken: key } : {}),
    agentId: brama.agentId,
    model: answer.model,
    imageModel: answer.model,
    direct: true,
  };
}
