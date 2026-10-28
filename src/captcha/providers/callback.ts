// The answer a captcha provider pushes to Weles once it solves a task.
//
// AntiCaptcha, CapMonster and CapSolver take a `callbackUrl` in createTask and
// 2captcha a `pingback`; each POSTs its answer there when the task is done.
// Reading getTaskResult or res.php back to back instead spends requests the
// providers ration (2captcha blocks an account that reads too often), and
// reading once answered every task as unsolved. So a task is created with the
// address of the Weles worker that started this run, the worker writes what
// the provider POSTs into the answers directory, and the run waits for that
// file: nothing is read until the provider has answered. A provider that
// accepts a task and never calls back leaves the run waiting on that file,
// its last line `waiting for its answer at the callback` (or `for its
// pingback`), until the run is cancelled (`weles runs cancel <run-id>`).
//
// The worker states both values in every run it starts (run/process/
// placement.mjs, runChildIdentity): WELES_CAPTCHA_CALLBACK_URL, the public
// HTTPS address its /captcha/answers/ route answers at, and
// WELES_CAPTCHA_ANSWERS_DIR, where that route writes. A run without them has
// no address a provider can reach, and its solve is refused naming that.

import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What a provider POSTed to the callback: its body and its content type, null
 * when the request carried no Content-Type header.
 */
export type ProviderAnswer = { contentType: string | null; body: string };

/** How `answer`'s body is described in a refusal: by its content type, or as having none. */
export function bodyKind(answer: ProviderAnswer): string {
  return answer.contentType === null ? 'a body without a Content-Type' : `a ${answer.contentType} body`;
}

/**
 * One task's callback: the address to give the provider, its answer, and
 * `abandon` for a task the provider refused, which stops waiting for it.
 */
export type ProviderCallback = {
  url: string;
  answer: () => Promise<ProviderAnswer>;
  abandon: () => Promise<void>;
};

function stated(name: string, meaning: string, service: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${service} cannot be given a task: ${name} is not set, so no provider can push its answer to this run (${meaning})`,
    );
  }
  return value;
}

// Waits for `file` to appear in `directory`. The watch starts before the file
// is looked for, so an answer written between the two is not missed; `close`
// stops the watch of a task that will never be answered.
function appeared(directory: string, file: string): { arrival: Promise<void>; close: () => void } {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const watcher = watch(directory, (_event, name) => {
    if (name !== file) return;
    watcher.close();
    resolve();
  });
  watcher.on('error', (error) => {
    watcher.close();
    reject(new Error(`watching ${directory} for ${file} failed: ${error.message}`, { cause: error }));
  });
  readFile(join(directory, file)).then(
    () => {
      watcher.close();
      resolve();
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return;
      watcher.close();
      reject(new Error(`reading ${join(directory, file)} failed: ${error.message}`, { cause: error }));
    },
  );
  return { arrival: promise, close: () => watcher.close() };
}

/**
 * A callback for one task of `service`. The run is registered as waiting
 * before the address is handed out, so the worker accepts the provider's POST
 * from the moment the task exists.
 */
export async function providerCallback(service: string): Promise<ProviderCallback> {
  const base = stated(
    'WELES_CAPTCHA_CALLBACK_URL',
    'the Weles worker that started the run states it from its WELES_CAPTCHA_CALLBACK_ORIGIN, the public HTTPS origin routed to it',
    service,
  );
  const directory = stated(
    'WELES_CAPTCHA_ANSWERS_DIR',
    'the Weles worker that started the run states where its /captcha/answers/ route writes',
    service,
  );
  const token = randomUUID();
  const waiting = join(directory, `${token}.waiting`);
  const answered = `${token}.json`;
  await mkdir(directory, { recursive: true });
  await writeFile(waiting, '');
  const { arrival, close } = appeared(directory, answered);
  return {
    url: new URL(token, base).toString(),
    // The route claimed the waiting marker when it took the answer, so only
    // the answer itself is left to remove once it is read.
    answer: async () => {
      await arrival;
      const path = join(directory, answered);
      const answer = JSON.parse(await readFile(path, 'utf8')) as ProviderAnswer;
      await rm(path);
      return answer;
    },
    abandon: async () => {
      close();
      await rm(waiting);
    },
  };
}
