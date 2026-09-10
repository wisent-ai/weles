import { WSession } from '../../../dist/session/wsession.js';
import { SessionStore } from '../../../dist/session/store.js';
import { ACTIONS, actionName, missingInputs } from './analytics-service/action-catalog.mjs';
import { safeGoto } from './analytics-service/page-interaction.mjs';
import { ensureLoggedIn } from './analytics-service/session-login.mjs';
import { humanIdlePause, humanScroll } from '../../../dist/human/mouse.js';
import { resolvedUrl, openExpectedDashboardSection } from './analytics-service/google-analytics/reports.mjs';
import {
  prepareWrite,
  performConfirmedWrite,
  verifyTargetSite,
  captureEvidence,
  assertExpectedEvidence,
  writeBanSignal,
} from './analytics-service/evidence.mjs';

async function run() {
  const name = actionName();
  const cfg = ACTIONS[name];
  if (!cfg) throw new Error(`unsupported analytics service action: ${name}`);

  const missing = missingInputs(cfg);
  if (missing.length) throw new Error(`missing required input(s): ${missing.join(', ')}`);

  const s = await WSession.start({ label: name, browser: 'chromium', proxy: process.env.PROXY_URL || 'direct', os: 'macos' });
  const store = new SessionStore();
  let actionError = null;
  try {
    await store.injectPlaywright?.(s.ctx, cfg.platform);
    if (name !== 'umami_register' && !name.includes('verify_tracking_script') && !name.includes('track_custom_event') && !name.includes('install_gtag')) {
      await ensureLoggedIn(s, cfg);
      await store.capturePlaywright?.(s.ctx, cfg.platform);
    }

    const pending = (cfg.risk === 'write' || cfg.risk === 'admin') && await prepareWrite(s, cfg);
    if (pending) {
      await safeGoto(s, resolvedUrl(cfg));
      await captureEvidence(s, cfg, { pending_review: true });
      writeBanSignal('pending_review', true, { risk: cfg.risk, reason: 'write/admin action staged for approval' });
      console.log(`PASS: ${name} pending_review`);
      return;
    }

    let extra = {};
    if (name === 'googleanalytics_verify_realtime') {
      extra.targetSite = await verifyTargetSite(s, cfg);
      await safeGoto(s, resolvedUrl(cfg));
      await humanIdlePause('long');
      await openExpectedDashboardSection(s);
    } else if (name.includes('verify_tracking_script') || name === 'umami_track_custom_event' || name === 'googleanalytics_install_gtag') {
      extra.targetSite = await verifyTargetSite(s, cfg);
    } else {
      await safeGoto(s, resolvedUrl(cfg));
      await humanIdlePause('long');
      if (cfg.platform === 'googleanalytics') await openExpectedDashboardSection(s);
      if (name !== 'googleanalytics_register' && name !== 'googleanalytics_register_needher') {
        for (let i = 0; i < 2; i++) await humanScroll(s.page, 800, 2);
      }
      if (cfg.risk === 'write' || cfg.risk === 'admin') {
        extra = { ...extra, ...await performConfirmedWrite(s, cfg) };
      }
    }

    const evidence = await captureEvidence(s, cfg, extra);
    assertExpectedEvidence(evidence);
    writeBanSignal('healthy', true, { final_url: evidence.url, evidence_file: 'service_action_result.json' });
    console.log(`PASS: ${name} ${cfg.objective}`);
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    try {
      await s.close();
    } catch (closeError) {
      if (!actionError) throw closeError;
      throw new Error(`${name} failed: ${actionError.message}; and the browser session was left open: ${closeError.message}`, { cause: actionError });
    }
  }
}

run()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    writeBanSignal('service_action_failed', false, { reason: e.message?.slice(0, 300) ?? String(e) });
    console.log('FAIL:', e.message?.slice(0, 300));
    process.exit(1);
  });
