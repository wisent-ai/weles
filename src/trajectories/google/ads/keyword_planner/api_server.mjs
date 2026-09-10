// Google Ads Keyword Planner API facade for a Mac mini running Weles.
// This HTTP server is only a transport wrapper around ads_keyword_planner_keeper.mjs.
// It must not call Google Ads REST/developer-token APIs; metrics remain UI-observed
// through the persistent Weles keeper and its logged-in browser profile.
//
// Env:
//   WELES_KEYWORD_PLANNER_API_TOKEN required unless WELES_KEYWORD_PLANNER_API_ALLOW_UNAUTH=1
//   WELES_KEYWORD_PLANNER_API_HOST  optional, default 127.0.0.1
//   WELES_KEYWORD_PLANNER_API_PORT  optional, default 8787
//   SESSION                         optional, default google_ads
//   STADO_MODEL_ROUTER_URL          required model-router endpoint
//   WELES_STADO_MODEL_ROUTER_TOKEN  required server-side model-router bearer
//   WELES_STADO_MODEL_ROUTER_AGENT_ID required Brama caller identity
//   WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET required Brama request-signing secret
//
// Example on Mac mini:
//   cd ~/Documents/CodingProjects/Wisent/weles
//   WELES_KEYWORD_PLANNER_API_HOST=0.0.0.0 \
//   WELES_KEYWORD_PLANNER_API_TOKEN="$WELES_CONSOLE_API_TOKEN" \
//   node src/trajectories/google/ads/keyword_planner/api_server.mjs

import http from 'node:http';
import { existsSync } from 'node:fs';
import { ALLOW_UNAUTH, API_TOKEN, HOST, PORT, RUNNER, SESSION, redact } from './api_server/service_settings.mjs';
import { authorized, json, readJsonBody, validateReportRequest, validateRequest } from './api_server/request_intake.mjs';
import { runKeywordPlanner } from './api_server/keeper_harvest.mjs';
import { generateKeywordsWithRouter } from './api_server/model_router.mjs';
import { buildKeywordReport, runKeywordReport } from './api_server/saturation_report.mjs';

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        source: 'weles_keyword_planner_api',
        authConfigured: Boolean(API_TOKEN || ALLOW_UNAUTH),
        session: SESSION,
        runner: RUNNER,
      });
      return;
    }

    const isKeywordVolume = req.method === 'POST' && url.pathname === '/google-ads/keyword-volume';
    const isKeywordReport = req.method === 'POST' && url.pathname === '/google-ads/keyword-report';
    if (!isKeywordVolume && !isKeywordReport) {
      json(res, 404, { ok: false, error: 'not_found' });
      return;
    }

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

    if (isKeywordVolume) {
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
});

server.listen(PORT, HOST, () => {
  console.log(`[weles-keyword-planner-api] listening http://${HOST}:${PORT} session=${SESSION} auth=${Boolean(API_TOKEN || ALLOW_UNAUTH)}`);
});
