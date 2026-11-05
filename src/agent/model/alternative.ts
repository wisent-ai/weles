// Where Weles's model request goes when no model route is named, or when the
// named Brama did not answer: handed whole to Stado (`stado capabilities call
// inference --consumer weles --json`), which asks the first alternative in
// its selected order that answers it — Brama, or a statement recorded for
// that exact request — and prints that answer, or refuses naming every
// alternative with its cause and the command that answers the kept request.
// Weles names no alternative and reads no key then, so one Stado gains later
// is used with no change here.
import { execFile } from 'node:child_process';

const CONSUMER = 'weles';
/** The command each request is handed to. */
export const STADO_CALL = [
  'capabilities',
  'call',
  'inference',
  '--consumer',
  CONSUMER,
  '--json',
] as const;

/**
 * The command for one request. A request no alternative answers yet is
 * waited on until a statement is recorded for it when the run sets
 * WELES_AWAIT_STATEMENT=1 (Stado's --await-statement), instead of refused:
 * a run someone attends answers its page questions with `stado capabilities
 * attestation record`, and the run goes on in the same session; a run
 * nobody attends leaves it unset and is refused naming the request.
 */
function stadoCall(): string[] {
  return process.env.WELES_AWAIT_STATEMENT === '1'
    ? [...STADO_CALL, '--await-statement']
    : [...STADO_CALL];
}

/** The command, as refusals and results name it. */
export const callOperation = `stado ${STADO_CALL.join(' ')}`;

/** Stado could not hand the request to any alternative, or could not run. */
export class NoAlternativeAnswered extends Error {}

/** The sentence Stado's failure envelope carries, else its last `Error:` line. */
function refusalOf(stdout: string, stderr: string): string {
  try {
    const envelope = JSON.parse(stdout) as { message?: unknown };
    if (typeof envelope.message === 'string' && envelope.message)
      return envelope.message;
  } catch {
    // Not an envelope: Stado ended before printing one.
  }
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  const error = lines.find((line) => line.startsWith('Error: '));
  return error ? error.slice('Error: '.length) : (lines[0] ?? 'it said nothing');
}

/**
 * One chat-completions `body`, answered by the alternative Stado chose: the
 * answer's text, as an endpoint would have sent it. Refused with
 * NoAlternativeAnswered carrying Stado's sentence, or naming the command
 * when Stado cannot run.
 */
export function callStado(body: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = execFile(
    'stado',
    stadoCall(),
    { encoding: 'utf8', maxBuffer: Number.MAX_SAFE_INTEGER },
    (error, stdout, stderr) => {
      if (error) {
        if (typeof error.code !== 'number') {
          reject(
            new NoAlternativeAnswered(
              `\`${callOperation}\` could not run: ${error.message}; install Stado, or name a model route with WELES_MODEL_ENDPOINT`,
              { cause: error },
            ),
          );
          return;
        }
        reject(
          new NoAlternativeAnswered(
            `no inference alternative answered \`${callOperation}\` (exit ${String(error.code)}): ${refusalOf(stdout, stderr)}`,
            { cause: error },
          ),
        );
        return;
      }
      let printed: { answer?: unknown };
      try {
        printed = JSON.parse(stdout) as { answer?: unknown };
      } catch (parseError) {
        reject(
          new Error(
            `\`${callOperation}\` printed an answer that is not JSON: ${stdout.trim()}`,
            { cause: parseError },
          ),
        );
        return;
      }
      if (printed.answer === undefined || printed.answer === null) {
        reject(new Error(`\`${callOperation}\` printed no answer: ${stdout.trim()}`));
        return;
      }
      resolve(JSON.stringify(printed.answer));
    },
  );
  child.stdin?.end(body);
  return promise;
}
