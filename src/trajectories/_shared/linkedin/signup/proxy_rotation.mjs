import { pageSettled } from '../../page/settled.mjs';
// Provider rotation + form-rendering probe for linkedin_login.mjs.

export async function pageHasLoginForm(page) {
  await pageSettled(page);
  const r = await page.evaluate(() => {
    const inputs = Array.from(
      document.querySelectorAll(
        'input[type="email"], input[name="session_key"], input#username',
      ),
    );
    const visible = inputs.filter(
      (i) => i.offsetParent !== null && i.offsetWidth > 0 && i.offsetHeight > 0,
    );
    return { visibleEmailInputs: visible.length };
  });
  return r.visibleEmailInputs > 0;
}

// Defer to resolveProxy in src/proxy/config.ts so per-provider sticky
// formats (oxylabs `customer-X-cc-us-sessid-N`, iproyal
// `pw_country-us_session-N`, pingproxies `user_c_us_s_N`, brightdata
// `user-country-us-session-N`) come from a single source of truth.
// Reproducing them inline is how the IPRoyal `_lifetime-30m` suffix bug
// happened (ERR_PROXY_AUTH_UNSUPPORTED at 04:47).
export async function freshProviderUrl(provider) {
  try {
    const mod = await import('../../../../../dist/proxy/config.js');
    // Request the ISP tier through the configured provider resolver.
    const tier = 'isp';
    const pw = await mod.resolveProxy(
      `${tier} ${provider} us`,
      'www.linkedin.com',
    );
    if (!pw?.server || !pw?.username) return null;
    const u = new URL(pw.server);
    u.username = encodeURIComponent(pw.username);
    u.password = encodeURIComponent(pw.password ?? '');
    return u.toString();
  } catch {
    return null;
  }
}

// Providers in the order this trajectory prefers them, each once; a
// rotation cycles through them for as many fresh exits as the budget allows.
export const PROVIDER_ROTATION = Object.freeze([
  'oxylabs',
  'iproyal',
  'pingproxies',
  'brightdata',
]);

// How many fresh proxy exits one login may probe is the operator's decision:
// LINKEDIN_PROXY_EXIT_BUDGET, required, a positive whole number.
export function proxyExitBudget() {
  const raw = process.env.LINKEDIN_PROXY_EXIT_BUDGET;
  const budget = Number(raw);
  if (!raw || !Number.isInteger(budget) || budget <= 0) {
    throw new Error(
      'LINKEDIN_PROXY_EXIT_BUDGET must name how many fresh proxy exits a login may probe (a positive whole number)',
    );
  }
  return budget;
}

// curl-based preflight: hit /login through the proxy and check whether the
// response body contains the markers a real form has. Cheap (no Chromium
// boot) — lets us probe many stickies before committing to one. A clean
// exit serves an HTML body containing `name="session_key"` and an email
// input; a flagged exit serves a stripped shell missing both.
export async function curlProbeLoginForm(proxyUrl) {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
    const args = [
      '-s',
      '-x',
      proxyUrl,
      '-H',
      `User-Agent: ${ua}`,
      'https://www.linkedin.com/login',
    ];
    execFile('curl', args, { maxBuffer: Infinity }, (err, stdout) => {
      if (err) return resolve({ ok: false, reason: err.message });
      const body = (stdout ?? '').toString();
      const hasSessionKey =
        /name="session_key"|id="username"|type="email"/.test(body);
      resolve({ ok: hasSessionKey, bodyLen: body.length });
    });
  });
}

// Cycle PROVIDER_ROTATION using curl preflight for at most `budget` fresh
// exits. Returns the first proxy URL that the curl probe says renders the real
// form and how many exits it took, or null with every exit spent.
// Caller can write that sessid to metadata.proxy so subsequent logins try
// the cached working sticky first.
export async function findUnflaggedSticky(budget) {
  for (let i = 0; i < budget; i++) {
    const provider = PROVIDER_ROTATION[i % PROVIDER_ROTATION.length];
    const url = await freshProviderUrl(provider);
    if (!url) {
      console.log(`[preflight] ${provider}: no creds — skipping`);
      continue;
    }
    const r = await curlProbeLoginForm(url);
    console.log(
      `[preflight] exit ${i + 1}/${budget} provider=${provider} ok=${r.ok} body=${r.bodyLen ?? '-'} reason=${r.reason ?? ''}`,
    );
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
export async function gotoLoginRotating({ session, persona, restartFn }) {
  let s = session;
  let activeProxy = null;
  let remaining = proxyExitBudget();
  let rotations = 0;
  while (true) {
    try {
      await s.page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
      });
      const url = s.page.url?.() ?? '';
      if (url.startsWith('chrome-error://'))
        throw new Error('goto_chrome_error');
      if (!(await pageHasLoginForm(s.page)))
        throw new Error('stripped_login_shell');
      console.log(
        `[linkedin_login] goto: full login form rendered (rotations=${rotations})`,
      );
      return { session: s, proxyUrl: activeProxy };
    } catch (e) {
      if (!/stripped_login_shell|goto_chrome_error/.test(e.message)) throw e;
      rotations += 1;
      console.log(
        `[linkedin_login] ${e.message} — rotating sticky (${remaining} exits left in LINKEDIN_PROXY_EXIT_BUDGET)`,
      );
      const fresh = await findUnflaggedSticky(remaining);
      if (!fresh)
        throw new Error(
          `no_unflagged_sticky_found: LINKEDIN_PROXY_EXIT_BUDGET spent after ${rotations} rotations: ${e.message}`,
        );
      remaining -= fresh.attempts;
      await s.close().catch(() => {});
      s = await restartFn(fresh.url, persona);
      activeProxy = fresh.url;
    }
  }
}
