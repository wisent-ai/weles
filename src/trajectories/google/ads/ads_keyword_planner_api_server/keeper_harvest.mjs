// Getting one harvest onto this machine. The persistent keeper owns the
// logged-in Google Ads browser profile, so this module proves the keeper is
// answering on its socket, starts it against that profile when it is not, then
// runs ads_keyword_planner_keeper.mjs as a child and reads back the result file
// it wrote — rewritten with credentials redacted before anyone else sees it.

import net from 'node:net';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DIAG_DIR,
  KEEPER,
  KEEPER_READY_TIMEOUT_MS,
  KEEPER_START,
  KEEPER_USER_DATA_DIR,
  REPO,
  RUNNER,
  redact,
  stripAmbientCredentialEnv,
} from './service_settings.mjs';
import { safeSlug } from './request_intake.mjs';

function keeperSocketPath(session) {
  return join(process.env.HOME || '', '.weles', 'keeper', session, 'socket');
}

function keeperAction(session, cmd) {
  return new Promise((resolveAction) => {
    const socket = keeperSocketPath(session);
    if (!existsSync(socket)) {
      resolveAction({ ok: false, error: 'keeper_socket_missing', socket });
      return;
    }
    const conn = net.createConnection(socket);
    let done = false;
    let buf = '';
    conn.on('connect', () => conn.write(`${JSON.stringify(cmd)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0 || done) return;
      done = true;
      conn.end();
      try {
        resolveAction(JSON.parse(buf.slice(0, nl)));
      } catch (error) {
        resolveAction({ ok: false, error: String(error?.message || error), socket });
      }
    });
    conn.on('error', (error) => {
      if (done) return;
      done = true;
      resolveAction({ ok: false, error: String(error?.message || error), socket });
    });
  });
}

async function waitForKeeper(session, readyWindowMs = KEEPER_READY_TIMEOUT_MS) {
  const deadline = Date.now() + readyWindowMs;
  let last = { ok: false, error: 'keeper_not_checked', socket: keeperSocketPath(session) };
  while (Date.now() < deadline) {
    last = await keeperAction(session, { action: 'url' });
    if (last?.ok) return { ready: true, socket: keeperSocketPath(session) };
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return { ready: false, socket: keeperSocketPath(session), lastError: last?.error || 'keeper_not_ready' };
}

async function ensureKeeper(session) {
  const existing = await keeperAction(session, { action: 'url' });
  if (existing?.ok) return { ready: true, started: false, socket: keeperSocketPath(session) };
  if (!KEEPER_START) {
    return { ready: false, started: false, disabled: true, socket: keeperSocketPath(session), lastError: existing?.error || 'keeper_start_disabled' };
  }
  if (!existsSync(KEEPER)) {
    return { ready: false, started: false, socket: keeperSocketPath(session), lastError: 'keeper_script_missing', keeper: KEEPER };
  }

  mkdirSync(DIAG_DIR, { recursive: true });
  mkdirSync(dirname(KEEPER_USER_DATA_DIR), { recursive: true });
  const logPath = join(DIAG_DIR, `keeper-${session}.log`);
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, [KEEPER], {
      cwd: REPO,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: stripAmbientCredentialEnv({
        ...process.env,
        WELES_REPO: REPO,
        SESSION: session,
        KEEPER_FLOW_ACTION: process.env.GOOGLE_ADS_KEEPER_FLOW_ACTION || 'google_ads_keyword_planner_keeper',
        KEEPER_USER_DATA_DIR,
        WELES_USER_DATA_DIR: KEEPER_USER_DATA_DIR,
        URL: process.env.GOOGLE_ADS_KEEPER_START_URL || 'https://ads.google.com/aw/overview',
      }),
    });
    child.unref();
  } finally {
    closeSync(fd);
  }

  const waited = await waitForKeeper(session);
  return { ...waited, started: true, logPath, userDataDir: KEEPER_USER_DATA_DIR };
}

// The child writes its metrics unredacted; nobody reads that file until it has
// been rewritten. Both refusals are answers this facade is allowed to give, so
// they are named rather than turned into a missing report.
function readRedactedPlannerResult(resultFile) {
  let report;
  try {
    report = JSON.parse(readFileSync(resultFile, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `planner result file ${resultFile} could not be read as JSON: ${error?.message || error}` };
  }
  try {
    writeFileSync(resultFile, JSON.stringify(JSON.parse(redact(JSON.stringify(report))), null, 2));
  } catch (error) {
    return { ok: false, reason: `planner result file ${resultFile} was read but could not be rewritten with credentials redacted: ${error?.message || error}` };
  }
  return report;
}

export async function runKeywordPlanner(input) {
  mkdirSync(DIAG_DIR, { recursive: true });
  const resultFile = join(DIAG_DIR, `${Date.now()}-${process.pid}-${safeSlug(input.keywords[0])}.json`);
  const keeper = await ensureKeeper(input.session);
  if (!keeper.ready) {
    return {
      ok: false,
      exitCode: 3,
      stdout: '',
      stderr: '',
      resultFile,
      keeper,
      report: {
        ok: false,
        blocked: 'keeper_not_ready',
        session: input.session,
        socket: keeper.socket,
        started: Boolean(keeper.started),
        lastError: keeper.lastError || null,
      },
    };
  }

  return await new Promise((resolveRun) => {
    const childEnv = stripAmbientCredentialEnv({
      ...process.env,
      SESSION: input.session,
      GOOGLE_ADS_CUSTOMER_ID: input.customerId,
      GOOGLE_ADS_KEYWORDS: input.keywords.join('\n'),
      GOOGLE_ADS_RESULT_FILE: resultFile,
      GOOGLE_ADS_CLOSE_AFTER_HARVEST: process.env.GOOGLE_ADS_CLOSE_AFTER_HARVEST || '0',
      GOOGLE_ADS_KEYWORD_BROWSER_AUTOMATION: '1',
      WELES_DISABLE_RECORDING: process.env.WELES_DISABLE_RECORDING || '1',
      WELES_NO_INSTRUMENT: process.env.WELES_NO_INSTRUMENT || '1',
      GOOGLE_SSO_NO_SCREENSHOTS: process.env.GOOGLE_SSO_NO_SCREENSHOTS || '1',
    });

    const child = spawn(process.execPath, [RUNNER], {
      cwd: REPO,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolveRun({ ok: false, exitCode: 1, stdout, stderr: `${stderr}\n${error?.message || error}`, resultFile, keeper, report: null });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const report = existsSync(resultFile) ? readRedactedPlannerResult(resultFile) : null;
      resolveRun({ ok: code === 0 && Boolean(report?.ok), exitCode: code, stdout, stderr, resultFile, keeper, report });
    });
  });
}
