import { humanIdlePause } from '../../../../dist/human/mouse.js';
// Provider rotation + form-rendering probe for linkedin_login.mjs.
//
// Cited from 2026-05-04 04:44 run output: 5 consecutive Oxylabs sticky
// re-rolls each served the degraded /login shell (zero email input) while
// the same weles binary direct from this Macs home IP rendered the full
// form (6 inputs, email present). LinkedIns edge fingerprints proxy IPs at
// first byte and serves a stripped page on flagged exits regardless of
// browser fingerprint. Re-rolling within a single provider exhausts when
// LinkedIn has flagged that providers exit pool for the day; rotating
// between providers gives us 4x the surface area before giving up.

export async function pageHasLoginForm(page) {
  await humanIdlePause('deliberate');
  try {
    // page.evaluate has NO default timeout in Playwright — if the page's
    // main thread is blocked by heavy PX crypto / infinite loops, evaluate
    // never resolves. Cited .work/li-login-grid-fixed.log 2026-05-06: log
    // idle 117s after "after goto", evaluate hung. Race with deadline.
    const evalP = page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="email"], input[name="session_key"], input#username'));
      const visible = inputs.filter(i => i.offsetParent !== null && i.offsetWidth > 0 && i.offsetHeight > 0);
      return { visibleEmailInputs: visible.length };
    });
    const deadline = new Promise((_, rej) => setTimeout(() => rej(new Error('eval_deadline')), 10000));
    const r = await Promise.race([evalP, deadline]);
    return r.visibleEmailInputs > 0;
  } catch { return false; }
}

// Defer to resolveProxy in src/proxy/config.ts so per-provider sticky
// formats (oxylabs `customer-X-cc-us-sessid-N`, iproyal
// `pw_country-us_session-N`, pingproxies `user_c_us_s_N`, brightdata
// `user-country-us-session-N`) come from a single source of truth.
// Reproducing them inline is how the IPRoyal `_lifetime-30m` suffix bug
// happened (ERR_PROXY_AUTH_UNSUPPORTED at 04:47).
export async function freshProviderUrl(provider) {
  try {
    const mod = await import('../../../../dist/proxy/config.js');
    // User rule (explicit, 2026-05-11): ISP-sticky pool for all LinkedIn
    // traffic. Earlier mobile/residential pin removed — random sticky exits
    // burned the signup flow per session telemetry. Only Oxylabs ISP
    // (isp.oxylabs.io:8001-8010, dedicated static IPs).
    const tier = 'isp';
    const pw = await mod.resolveProxy(`${tier} ${provider} us`, 'www.linkedin.com');
    if (!pw?.server || !pw?.username) return null;
    const u = new URL(pw.server);
    u.username = encodeURIComponent(pw.username);
    u.password = encodeURIComponent(pw.password ?? '');
    return u.toString();
  } catch { return null; }
}

// Weighted toward Oxylabs because account_action_logs cited 2026-05-04
// shows Oxylabs sticky 4691193 produced a healthy /feed PASS at 03:51:23
// while sticky 9764033 (same pr.oxylabs.io gateway) hit hard-timeout at
// 00:57 and 9716730 hit checkpoint at 22:29 — only the sticky session id
// varied. Roll many Oxylabs sessids before falling back to other providers.
export const PROVIDER_ROTATION = (() => {
  const seq = [];
  for (let i = 0; i < 20; i++) seq.push('oxylabs');
  for (let i = 0; i < 4; i++) for (const p of ['iproyal', 'pingproxies', 'brightdata']) seq.push(p);
  return seq;
})();

// curl-based preflight: hit /login through the proxy and check whether the
// response body contains the markers a real form has. Cheap (no Chromium
// boot) — lets us probe many stickies before committing to one. Confirmed
// 2026-05-04 04:41: a clean exit serves an HTML body containing
// `name="session_key"` and an email input; a flagged exit serves a stripped
// shell missing both.
export async function curlProbeLoginForm(proxyUrl, timeoutSecs = 12) {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
    const args = ['-s', '--max-time', String(timeoutSecs), '-x', proxyUrl, '-H', `User-Agent: ${ua}`, 'https://www.linkedin.com/login'];
    execFile('curl', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, reason: err.message?.slice(0, 80) });
      const body = (stdout ?? '').toString();
      const hasSessionKey = /name="session_key"|id="username"|type="email"/.test(body);
      resolve({ ok: hasSessionKey, bodyLen: body.length });
    });
  });
}

// Iterate PROVIDER_ROTATION using curl preflight. Returns the first proxy
// URL that the curl probe says renders the real form, plus the sessid.
// Caller can write that sessid to metadata.proxy so subsequent logins try
// the cached working sticky first.
export async function findUnflaggedSticky(maxAttempts = PROVIDER_ROTATION.length) {
  for (let i = 0; i < maxAttempts; i++) {
    const provider = PROVIDER_ROTATION[i % PROVIDER_ROTATION.length];
    const url = await freshProviderUrl(provider);
    if (!url) { console.log(`[preflight] ${provider}: no creds — skipping`); continue; }
    const r = await curlProbeLoginForm(url);
    console.log(`[preflight] attempt ${i + 1} provider=${provider} ok=${r.ok} body=${r.bodyLen ?? '-'} reason=${r.reason ?? ''}`);
    if (r.ok) return { url, provider, attempts: i + 1 };
  }
  return null;
}

// Goto /login with sticky-rotation on stripped-shell / chrome-error. The
// trajectory's old single-attempt path failed permanently when the
// initial proxy IP was edge-flagged by LinkedIn. Now: on those two errors
// we curl-probe fresh stickies via findUnflaggedSticky, tear down the
// session, and restart with the working URL. Caller passes restartFn to
// rebuild the WSession with the new proxy. Returns the (possibly fresh)
// session + the proxyUrl actually in use.
export async function gotoLoginRotating({ session, persona, restartFn, maxRotations = 5, gotoTimeoutMs = 30000 }) {
  let s = session;
  let activeProxy = null;
  let attempts = 0;
  while (true) {
    try {
      await s.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs });
      const url = s.page.url?.() ?? '';
      if (url.startsWith('chrome-error://')) throw new Error('goto_chrome_error');
      if (!(await pageHasLoginForm(s.page))) throw new Error('stripped_login_shell');
      console.log(`[linkedin_login] goto: full login form rendered (rotations=${attempts})`);
      return { session: s, proxyUrl: activeProxy };
    } catch (e) {
      if (!/stripped_login_shell|goto_chrome_error/.test(e.message)) throw e;
      if (++attempts > maxRotations) throw new Error(`rotation_exhausted_after_${attempts}: ${e.message}`);
      console.log(`[linkedin_login] ${e.message} — rotating sticky (rotation ${attempts}/${maxRotations})`);
      const fresh = await findUnflaggedSticky(8);
      if (!fresh) throw new Error('no_unflagged_sticky_found');
      await s.close().catch(() => {});
      s = await restartFn(fresh.url, persona);
      activeProxy = fresh.url;
    }
  }
}
