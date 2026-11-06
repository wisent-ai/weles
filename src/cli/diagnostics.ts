import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WELES_AGENT_MODEL } from '../agent/jeden.js';
import { resolveSkarbiecEndpoint } from '../utils/runtime/endpoint-resolution.js';
import { listLoginAccounts } from '../utils/login-accounts.js';
import { printAnswer } from './usage.js';
import { inspectBrowserRuntime } from './diagnostics/browser-runtime.js';
export async function runDoctor(
  pkg: { version?: string; bin?: unknown },
  json: boolean,
): Promise<void> {
  const report: Record<string, unknown> = {
    ok: true,
    version: pkg.version,
    node: process.version,
    bin: pkg.bin,
    env: {
      CHROMIUM_PATH: process.env.CHROMIUM_PATH ? 'set' : 'unset',
      WELES_USE_STOCK_CHROMIUM: process.env.WELES_USE_STOCK_CHROMIUM
        ? 'set'
        : 'unset',
    },
    dependencies: {
      skarbiec: null as unknown,
      browserRuntime: null as unknown,
    },
  };

  try {
    const skarbiecResult = await resolveSkarbiecEndpoint();
    if (skarbiecResult.resolved) {
      report.dependencies = {
        skarbiec: {
          resolved: skarbiecResult.resolved.url,
          source: skarbiecResult.resolved.source,
          sourceDetail: skarbiecResult.resolved.sourceDetail,
          isListening: skarbiecResult.resolved.isListening,
        },
      };
      if (!skarbiecResult.resolved.isListening) {
        report.ok = false;
      }
    }
  } catch (error) {
    report.dependencies = {
      skarbiec: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
    report.ok = false;
  }

  // A worker that will die on its first browser task should say so here
  // rather than at the fourth failed job. `browserContext.newPage` needs the
  // recording dependency before it will open a page at all, so an absent
  // ffmpeg is not a degraded run, it is every browser task on the host
  // failing -- and it reported itself only as a run failure hours later.
  const runtime = await inspectBrowserRuntime();
  report.dependencies = {
    ...(report.dependencies as Record<string, unknown>),
    browserRuntime: runtime,
  };
  if (!runtime.ok) {
    report.ok = false;
  }

  // Which revision this host actually built, against the revision the
  // deployment declares, and the Brama alias that revision will ask for. A
  // managed runtime weeks behind its own repository can ask Brama for a
  // route whose credentials have lapsed, so every browser task on the host
  // fails while the host's own bearer is being served; a `doctor` that
  // reports the version in `package.json` reports the repository's, not the
  // runtime's, and never names the gap.
  const managed = inspectManagedRuntime();
  report.managedRuntime = managed;
  if (!managed.ok) {
    report.ok = false;
  }

  try {
    const identities = listLoginAccounts();
    report.subscriptionAuthentication = { source: 'skarbiec', ...identities };
    if (identities.errors.length) report.ok = false;
  } catch (error) {
    report.subscriptionAuthentication = {
      source: 'skarbiec',
      accounts: [],
      errors: [
        {
          code: 'skarbiec_inventory_unavailable',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
    report.ok = false;
  }

  printAnswer(report, json);
  if (!report.ok) {
    // Node's failure exit: https://nodejs.org/api/process.html#exit-codes
    process.exitCode = 1;
  }
}

type ManagedRuntimeReport = {
  ok: boolean;
  root: string;
  builtRevision: string | null;
  declaredRevision: string | null;
  agentModelAlias: string;
  detail?: string;
};

// Compare the deployment's revision marker with its declaration; absence is
// healthy only when no managed runtime is declared. This is metadata, not
// proof that the browser or its dependencies work.
function inspectManagedRuntime(): ManagedRuntimeReport {
  const root = join(homedir(), '.stado', 'build-work', 'weles-api-managed');
  const declaredRevision = revision(process.env.WELES_API_DECLARED_REVISION);
  const report: ManagedRuntimeReport = {
    ok: false,
    root,
    builtRevision: null,
    declaredRevision,
    agentModelAlias: WELES_AGENT_MODEL,
  };
  try {
    const builtRevision = readRevisionMarker(join(root, '.weles-api-revision'));
    report.builtRevision = builtRevision;
    if (!builtRevision) {
      report.ok = !declaredRevision;
      report.detail = declaredRevision
        ? `managed Weles API revision marker ${join(root, '.weles-api-revision')} is missing; cannot verify declared revision ${declaredRevision}`
        : 'this host runs no managed Weles API runtime';
    } else if (!declaredRevision) {
      report.ok = true;
      report.detail =
        'the unit declares no revision, so this reports what is installed and compares nothing';
    } else if (builtRevision !== declaredRevision) {
      report.detail = `the installed runtime is ${builtRevision} and the unit declares ${declaredRevision}; deliver the matching managed Weles release through Stado product delivery`;
    } else {
      report.ok = true;
    }
  } catch (error) {
    report.detail = error instanceof Error ? error.message : String(error);
  }
  return report;
}

function revision(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  // Full SHA-1 object name: https://git-scm.com/docs/hash-function-transition
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

function readRevisionMarker(path: string): string | null {
  try {
    const observed = revision(readFileSync(path, 'utf8'));
    if (!observed)
      throw new Error('expected a full hexadecimal source revision');
    return observed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `read managed Weles API revision marker ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
