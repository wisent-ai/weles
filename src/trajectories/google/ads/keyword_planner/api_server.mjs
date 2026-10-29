// Google Ads Keyword Planner routes of the Weles API process.
// This module is only a transport wrapper around the keeper runner
// (keyword_planner/keeper.mjs). It must not call Google Ads REST/developer-token
// APIs; metrics remain UI-observed through the Weles keeper session and its
// logged-in browser profile.
//
// There is no separate keyword-planner server or unit. POST /google-ads/keyword-volume
// and POST /google-ads/keyword-report are answered by the one Weles process
// (src/worker/weles-api-server.mjs), behind the same WELES_API_TOKEN as every
// other token-authenticated route (requireTokenAuthorization).
//
// Env of the Weles process:
//   SESSION / GOOGLE_ADS_KEEPER_SESSION the keeper session a request runs in when
//                                   it names none; with neither, a request without
//                                   `session` is refused
//   GOOGLE_ADS_AUTHUSER             the browser's Google account index the customer
//                                   is signed in as (read by the keeper runner)
//   STADO_MODEL_ROUTER_URL          required model-router endpoint
//   WELES_STADO_MODEL_ROUTER_TOKEN  required server-side model-router bearer
//   WELES_STADO_MODEL_ROUTER_AGENT_ID required Brama caller identity
//   WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET required Brama request-signing secret

import { existsSync } from 'node:fs';
import { RUNNER, redact } from './api_server/service_settings.mjs';
import {
  validateReportRequest,
  validateRequest,
} from './api_server/request_intake.mjs';
import {
  json,
  readBody,
  requireTokenAuthorization,
} from '../../../../worker/weles-api-server/http-exchange.mjs';
import { runKeywordPlanner } from './api_server/keeper_harvest.mjs';
import { generateKeywordsWithRouter } from './api_server/model_router.mjs';
import {
  buildKeywordReport,
  runKeywordReport,
} from './api_server/saturation_report.mjs';
import {
  HTTP_INVALID_REQUEST,
  HTTP_OK,
  HTTP_SERVER_MISCONFIGURED,
  HTTP_UPSTREAM_FAILED,
} from '../../../../worker/weles-api-server/routes/http-status.mjs';

const KEYWORD_VOLUME = '/google-ads/keyword-volume';
const KEYWORD_REPORT = '/google-ads/keyword-report';

export function isKeywordPlannerRoute(req, url) {
  return (
    req.method === 'POST' &&
    (url.pathname === KEYWORD_VOLUME || url.pathname === KEYWORD_REPORT)
  );
}

export async function respondToKeywordPlanner(req, res, url) {
  try {
    if (!requireTokenAuthorization(req, res)) return;

    if (!existsSync(RUNNER)) {
      json(res, HTTP_SERVER_MISCONFIGURED, {
        ok: false,
        error: 'keyword_planner_keeper_runner_missing',
        runner: RUNNER,
      });
      return;
    }

    const body = await readBody(req);
    const startedAt = new Date().toISOString();

    if (url.pathname === KEYWORD_VOLUME) {
      const input = validateRequest(body);
      const run = await runKeywordPlanner(input);
      const response = {
        ok: Boolean(run.ok),
        source: 'weles_keyword_planner_api',
        session: input.session,
        customer: input.customerId,
        keywordCount: input.keywords.length,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: run.exitCode,
        resultFile: run.resultFile,
        stdoutTail: redact(run.stdout),
        stderrTail: redact(run.stderr),
        report: run.report,
      };
      json(res, response.ok ? HTTP_OK : HTTP_UPSTREAM_FAILED, response);
      return;
    }

    const input = validateReportRequest(body);
    const generation = await generateKeywordsWithRouter(input);
    const run = await runKeywordReport(input, generation);
    const report = buildKeywordReport(input, generation, run);
    const response = {
      ok: Boolean(run.ok),
      source: 'weles_keyword_report_api',
      session: input.session,
      customer: input.customerId,
      keywordCount: report.metrics.checkedKeywordCount,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: run.exitCode,
      resultFile: run.resultFile,
      stdoutTail: redact(run.stdout),
      stderrTail: redact(run.stderr),
      report,
    };
    json(res, response.ok ? HTTP_OK : HTTP_UPSTREAM_FAILED, response);
  } catch (error) {
    // The keeper, runner and result-file failures carry their upstream
    // status; any other error is answered as a bad request with its message.
    json(res, error.status ? error.status : HTTP_INVALID_REQUEST, {
      ok: false,
      error: error.message,
    });
  }
}
