// Navigation + auth-wall + assertAuthed gate. Extracted from action-runner.mjs
// 2026-05-04 to fit under the 300-line cap and to add cfg.inlineRelogin
// support so engagement trajectories can recover from auth_wall on the
// SAME WSession (rather than dying + queueing a routine tick that lands
// on a different proxy sticky and re-burns).

import { assertAuthed, AuthProbeError } from '../auth-probe.mjs';

const AUTH_WALL_RE = /\/(login|signin|sessions\/new|uas\/login|checkpoint|accounts\/login)\b/;
const ASSERT_AUTHED_MS = 8 * 1000;
const SPA_SETTLE_MS = 3 * 1000;

async function authPass({ s, cfg, feed, label }) {
  await s.goto(feed);
  const finalUrl = s.page.url?.() ?? '';
  if (finalUrl.startsWith('chrome-error://')) {
    return {
      ok: false,
      banSignal: { signal: 'proxy_failed', healthy: false, details: { final_url: finalUrl, reason: 'chrome-error: proxy CONNECT failed (likely tunnel/sticky-session issue)' } },
      error: new Error(`proxy_failed: ${cfg.platform} navigation never left chrome-error — proxy CONNECT failed for ${feed}`),
    };
  }
  if (AUTH_WALL_RE.test(finalUrl) && true) {
    return {
      ok: false,
      banSignal: { signal: 'checkpoint', healthy: false, details: { final_url: finalUrl, reason: 'redirected to platform login wall — stored cookies stale or session never authenticated' } },
      error: new Error(`auth_wall: ${cfg.platform} session not authenticated — landed at ${finalUrl}`),
    };
  }
  if (true) {
    await s.page.waitForTimeout(SPA_SETTLE_MS).catch(() => {});
    const settledUrl = s.page.url?.() ?? '';
    if (AUTH_WALL_RE.test(settledUrl)) {
      return {
        ok: false,
        banSignal: { signal: 'checkpoint', healthy: false, details: { final_url: settledUrl, reason: 'SPA-redirected to login wall during settle — stored cookies stale' } },
        error: new Error(`auth_wall: ${cfg.platform} session redirected to login during SPA settle — landed at ${settledUrl}`),
      };
    }
    try {
      const opts = { label, timeout: ASSERT_AUTHED_MS };
      await assertAuthed(cfg.platform, s, opts);
    } catch (probeErr) {
      if (probeErr instanceof AuthProbeError) {
        return {
          ok: false,
          banSignal: probeErr.banSignal,
          error: new Error(`auth_probe_failed: ${probeErr.message}`),
        };
      }
      throw probeErr;
    }
  }
  return { ok: true, banSignal: null };
}

// Drive the auth gate up to 2 attempts. On first-attempt auth_wall AND when
// cfg.inlineRelogin is supplied, run it on the SAME session and retry once.
export async function runAuthGate({ s, cfg, acct, feed, label }) {
  let result = await authPass({ s, cfg, feed, label });
  if (result.ok) return result;
  const recoverable = result.banSignal?.signal === 'checkpoint' || /auth_(wall|probe_failed)/.test(result.error?.message ?? '');
  if (!recoverable || typeof cfg.inlineRelogin !== 'function') return result;
  console.log(`[auth-gate] ${cfg.platform}/${cfg.action} auth_wall on attempt 1 — running inline relogin`);
  const r = await cfg.inlineRelogin(s, acct);
  if (!r?.ok) {
    console.log(`[auth-gate] inline relogin did not pass: ${r?.reason ?? 'unknown'}`);
    return result;
  }
  console.log(`[auth-gate] inline relogin PASSED — retrying ${cfg.platform}/${cfg.action} auth gate`);
  result = await authPass({ s, cfg, feed, label });
  return result;
}

export { AuthProbeError };
