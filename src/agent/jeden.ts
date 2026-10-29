import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../session/run-recordings.js';
import { insteadOfBrama } from './model/alternative.js';
import {
  completeThroughRouter,
  RouteUnreachable,
  type JedenResult,
  type ModelOnlyOptions,
} from './model/router-call.js';
import {
  loadModelRouterConfig,
  type ModelRouterConfig,
} from './model/router-config.js';

/**
 * Brama did not answer this process's last model call: the next one asks
 * Stado which alternative stands (its kept proof, so no second knock on a
 * Brama it already found down) instead of knocking on Brama first.
 */
let bramaUnanswered = false;

// Text decisions use this workload's Brama alias. Image questions use `best`,
// which selects an image-capable model from the same caller's authorized pool.
// Brama owns provider choice and permissions; Weles never substitutes a vendor
// on its own. Only a user without Brama names one, with WELES_MODEL_ENDPOINT
// and WELES_MODEL: that provider then answers both text and image questions.
export const WELES_AGENT_MODEL = 'weles';

export type JedenCallOptions = {
  maxSteps?: number;
} & (ModelOnlyOptions | { modelOnly: false; cwd: string });

/**
 * The process mechanics the Jeden child inherits. Browser-session, provider
 * and sibling Stado credentials never become its ambient environment.
 */
const INHERITED_ENVIRONMENT: Readonly<Record<string, true>> = Object.freeze({
  HOME: true,
  LANG: true,
  LC_ALL: true,
  LC_CTYPE: true,
  PATH: true,
  SSL_CERT_DIR: true,
  SSL_CERT_FILE: true,
  SystemRoot: true,
  TEMP: true,
  TMP: true,
  TMPDIR: true,
  XDG_CONFIG_HOME: true,
});

/** The setting's text, trimmed; absent when unset or blank. */
function setting(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function runJedenProcess(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
  }>();
  execFile(
    binary,
    args,
    { cwd: process.cwd(), env, encoding: 'utf8', maxBuffer: Infinity },
    (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout).trim();
        reject(
          new Error(
            `Jeden ${binary} failed: code=${String(error.code)} signal=${String(error.signal)} killed=${String(error.killed)}${detail ? `; ${detail}` : ''}`,
            { cause: error },
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    },
  );
  return promise;
}

/** The model route the child is given: the direct provider, or Brama with this workload's identity. */
function routingEnvironment(cfg: ModelRouterConfig): NodeJS.ProcessEnv {
  if (cfg.direct)
    return {
      JEDEN_MODEL_ENDPOINT: cfg.routerUrl,
      ...(cfg.routerToken ? { JEDEN_MODEL_KEY: cfg.routerToken } : {}),
    };
  return {
    STADO_MODEL_ROUTER_URL: cfg.routerUrl,
    STADO_MODEL_ROUTER_TOKEN: cfg.routerToken,
    BRAMA_URL: cfg.routerUrl,
    BRAMA_TOKEN: cfg.routerToken,
    WISENT_APP_AGENT_ID: cfg.agentId,
    WISENT_APP_AGENT_AUTH_SECRET: cfg.agentAuthSecret,
  };
}

export async function callJeden(
  prompt: string,
  options: JedenCallOptions = {},
): Promise<JedenResult> {
  const cfg = loadModelRouterConfig(WELES_AGENT_MODEL);
  // A turn ends when the gateway answers or the process exits. The browser
  // loop's decision call takes as long as the model takes to think, and a
  // reasoning route that needed six minutes was reported here as a failure of
  // ours.
  //
  // Only a caller that explicitly wants the agent runtime's tools
  // (`modelOnly: false`) spawns the binary.
  if (options.modelOnly !== false) {
    const asked =
      bramaUnanswered && !cfg.direct
        ? insteadOfBrama('it did not answer this process before', cfg, false)
        : cfg;
    try {
      const answered = await completeThroughRouter(asked, prompt, options);
      if (asked === cfg) bramaUnanswered = false;
      return answered;
    } catch (error) {
      if (asked.direct || !(error instanceof RouteUnreachable)) throw error;
      bramaUnanswered = true;
      return completeThroughRouter(
        insteadOfBrama(error.message, cfg, true),
        prompt,
        options,
      );
    }
  }
  const binary =
    setting('WELES_JEDEN_BIN') ??
    join(__dirname, '..', '..', 'native', 'jeden', 'bin', 'jeden');
  const sessionRoot =
    setting('WELES_JEDEN_SESSION_ROOT') ??
    join(runRecordingsDir('jeden'), 'sessions');
  mkdirSync(sessionRoot, { recursive: true });
  const args = ['run', prompt, '--json', '--model', cfg.model];
  // A step bound reaches Jeden only when the caller states one; otherwise the
  // run ends when Jeden's own turn ends, not at a count nobody chose.
  if (options.maxSteps !== undefined)
    args.push('--max-steps', String(options.maxSteps));
  args.push('--cwd', options.cwd);
  const inherited: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(INHERITED_ENVIRONMENT)) {
    const value = process.env[name];
    if (value) inherited[name] = value;
  }
  const { stdout } = await runJedenProcess(binary, args, {
    ...inherited,
    ...routingEnvironment(cfg),
    JEDEN_SESSION_ROOT: sessionRoot,
  });
  let envelope: { ok?: boolean; text?: unknown; originalError?: unknown };
  try {
    envelope = JSON.parse(stdout) as typeof envelope;
  } catch (error) {
    throw new Error(`Jeden returned invalid JSON: ${stdout.trim()}`, {
      cause: error,
    });
  }
  const raw = typeof envelope.text === 'string' ? envelope.text.trim() : '';
  if (envelope.ok !== true || !raw) {
    throw new Error(
      `Jeden returned no model output: ${JSON.stringify(envelope)}`,
    );
  }
  return { raw, model: cfg.model, routerUrl: cfg.routerUrl };
}
