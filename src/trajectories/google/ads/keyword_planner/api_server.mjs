// Google Ads Keyword Planner routes of the Weles API process.
// This module is only a transport wrapper around ads_keyword_planner_keeper.mjs.
// It must not call Google Ads REST/developer-token APIs; metrics remain UI-observed
// through the Weles keeper session and its logged-in browser profile.
//
// There is no separate keyword-planner server or unit. POST /google-ads/keyword-volume
// and POST /google-ads/keyword-report are answered by the one Weles process
// (src/worker/weles-api-server.mjs), authenticated with this facade's own bearer.
//
// Env of the Weles process:
//   WELES_KEYWORD_PLANNER_API_TOKEN required unless WELES_KEYWORD_PLANNER_API_ALLOW_UNAUTH=1
//   SESSION                         optional, default google_ads
//   STADO_MODEL_ROUTER_URL          required model-router endpoint
//   WELES_STADO_MODEL_ROUTER_TOKEN  required server-side model-router bearer
//   WELES_STADO_MODEL_ROUTER_AGENT_ID required Brama caller identity
//   WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET required Brama request-signing secret

import { existsSync } from 'node:fs';
import { ALLOW_UNAUTH, API_TOKEN, RUNNER, redact } from './api_server/service_settings.mjs';
import { authorized, json, readJsonBody, validateReportRequest, validateRequest } from './api_server/request_intake.mjs';
import { runKeywordPlanner } from './api_server/keeper_harvest.mjs';
import { generateKeywordsWithRouter } from './api_server/model_router.mjs';
import { buildKeywordReport, runKeywordReport } from './api_server/saturation_report.mjs';

const KEYWORD_VOLUME = '/google-ads/keyword-volume';
const KEYWORD_REPORT = '/google-ads/keyword-report';

export function isKeywordPlannerRoute(req, url) {
  return req.method === 'POST' && (url.pathname === KEYWORD_VOLUME || url.pathname === KEYWORD_REPORT);
}

export async function respondToKeywordPlanner(req, res, url) {
  try {
    if (!authorized(req)) {
      json(res, API_TOKEN || ALLOW_UNAUTH ? 401 : 500, {
        ok: false,
        error: API_TOKEN || ALLOW_UNAUTH ? 'unauthorized' : 'missing_WELES_KEYWORD_PLANNER_API_TOKEN',
      });
      return;
    }

    if (!existsSync(RUNNER)) {
      json(res, 500, { ok: false, error: 'ads_keyword_planner_keeper_missing', runner: RUNNER });
      return;
    }

    const body = await readJsonBody(req);
    const startedAt = new Date().toISOString();

    if (url.pathname === KEYWORD_VOLUME) {
      const input = validateRequest(body);
      const run = await runKeywordPlanner(input);
      const response = {
        ok: Boolean(run.ok),
        source: 'weles_mac_mini_keyword_planner_api',
        session: input.session,
        customer: input.customerId,
        keywordCount: input.keywords.length,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: run.exitCode,
        resultFile: run.resultFile,
        stdoutTail: redact(run.stdout).slice(-4000),
        stderrTail: redact(run.stderr).slice(-2000),
        report: run.report,
        keeper: run.keeper,
      };
      json(res, response.ok ? 200 : 502, response);
      return;
    }

    const input = validateReportRequest(body);
    const generation = await generateKeywordsWithRouter(input);
    const run = await runKeywordReport(input, generation);
    const report = buildKeywordReport(input, generation, run);
    const response = {
      ok: Boolean(run.ok),
      source: 'weles_mac_mini_keyword_report_api',
      session: input.session,
      customer: input.customerId,
      keywordCount: report.metrics.checkedKeywordCount,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: run.exitCode,
      resultFile: run.resultFile,
      stdoutTail: redact(run.stdout).slice(-4000),
      stderrTail: redact(run.stderr).slice(-2000),
      report,
      keeper: run.keeper,
    };
    json(res, response.ok ? 200 : 502, response);
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error) });
  }
}
