import { pageSettled } from '../../page/settled.mjs';
import { statedProxy } from '../../inputs/stated.mjs';
// Reaching LinkedIn's login form through the account's one proxy.
//
// An account that has a pinned proxy keeps it: the exit LinkedIn knows the
// account by is never swapped for another, so a pinned exit that LinkedIn
// will not serve the form through ends the login with that refusal. Only an
// account without a pin, browsing through the proxy request the run states
// (PROXY_URL), may be given a fresh exit of that same request, probed first
// with the headers the session's own persona sends.

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

// A fresh exit of the stated proxy request, as a proxy URL carrying its
// credentials, resolved by the one resolver (src/proxy/config.ts) with the
// session's persona, so the resolver's own preflight probes it as the
// browser that will use it. A request the resolver cannot satisfy is thrown
// with the resolver's words.
async function freshExit(request, persona) {
  const mod = await import('../../../../../dist/proxy/config.js');
  const pw = await mod.resolveProxy(request, 'www.linkedin.com', persona);
  if (!pw?.server)
    throw new Error(
      `LINKEDIN_PROXY_UNRESOLVED: the stated proxy request "${request}" resolved no exit for www.linkedin.com`,
    );
  const u = new URL(pw.server);
  if (pw.username) u.username = encodeURIComponent(pw.username);
  if (pw.password) u.password = encodeURIComponent(pw.password);
  return u.toString();
}

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

// Fetches /login through `proxyUrl` with the persona's navigation headers and
// answers whether the body holds the markers a real form has. A curl that
// fails is thrown with curl's words, the proxy URL withheld.
async function exitServesLoginForm(proxyUrl, persona) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { probeHeaders } = await import(
    '../../../../../dist/proxy/quality/platform_probes.js'
  );
  const headers = probeHeaders(persona);
  const args = [
    '-sS',
    '--compressed',
    '-x',
    proxyUrl,
    ...Object.entries(headers).flatMap(([name, value]) => [
      '-H',
      `${name}: ${value}`,
    ]),
    'https://www.linkedin.com/login',
  ];
  try {
    const { stdout } = await promisify(execFile)('curl', args, {
      encoding: 'utf8',
      maxBuffer: Infinity,
    });
    return {
      ok: /name="session_key"|id="username"|type="email"/.test(stdout),
      bodyLen: stdout.length,
    };
  } catch (error) {
    throw new Error(
      `LINKEDIN_LOGIN_PROBE_FAILED: ${String(error?.message ?? error).replaceAll(proxyUrl, '[proxy-url]')}`,
    );
  }
}

// Goto /login. A chrome-error document or a page without the form on a
// pinned exit ends the login with that refusal; on a stated request the
// session is restarted on fresh exits of the same request until one serves
// the form or LINKEDIN_PROXY_EXIT_BUDGET is spent. Caller passes restartFn
// to rebuild the WSession with the new proxy. Returns the (possibly fresh)
// session + the proxyUrl actually in use (null when the first one served).
export async function gotoLoginRotating({
  session,
  persona,
  pinned,
  restartFn,
}) {
  let s = session;
  let activeProxy = null;
  let remaining = null;
  let rotations = 0;
  while (true) {
    // The two outcomes a fresh exit can cure are read from the page itself:
    // a chrome-error document, or a page without the login form. Any error
    // the navigation throws is not one of them and ends the attempt.
    await s.page.goto('https://www.linkedin.com/login', {
      waitUntil: 'domcontentloaded',
    });
    const url = s.page.url();
    let refusal = null;
    if (url.startsWith('chrome-error://')) refusal = 'goto_chrome_error';
    else if (!(await pageHasLoginForm(s.page)))
      refusal = 'stripped_login_shell';
    if (refusal === null) {
      console.log(
        `[linkedin_login] goto: full login form rendered (rotations=${rotations})`,
      );
      return { session: s, proxyUrl: activeProxy };
    }
    if (pinned)
      throw new Error(
        `LINKEDIN_PINNED_EXIT_REFUSED: ${refusal} on the account's pinned proxy; the account keeps its one exit, so the login ends here`,
      );
    const request = statedProxy(
      'the LinkedIn login, whose account has no proxy pin,',
    );
    remaining ??= proxyExitBudget();
    let fresh = null;
    while (!fresh && remaining > 0) {
      remaining -= 1;
      const candidate = await freshExit(request, persona);
      const served = await exitServesLoginForm(candidate, persona);
      console.log(
        `[linkedin_login] probed a fresh exit of "${request}": form=${served.ok} body=${served.bodyLen} (${remaining} left in LINKEDIN_PROXY_EXIT_BUDGET)`,
      );
      if (served.ok) fresh = candidate;
    }
    if (!fresh)
      throw new Error(
        `no_unflagged_exit_found: LINKEDIN_PROXY_EXIT_BUDGET spent after ${rotations} rotation(s) of "${request}": ${refusal}`,
      );
    rotations += 1;
    await s
      .close()
      .catch((e) => console.log(`[session] close failed: ${e.message}`));
    s = await restartFn(fresh, persona);
    activeProxy = fresh;
  }
}
