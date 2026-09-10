import { resolveProxy } from '../../../../dist/proxy/config.js';

// Sticky-IP preservation. Each linkedin_login session MUST reuse the exit-IP
// cohort the account first registered + last successfully logged in from —
// otherwise LinkedIn's risk model treats the shift as account-takeover and
// forces /checkpoint with the captcha grid (cited 2026-05-08T06:25 run,
// frame_last.png of the login diagnostics).
//
// resolveAccountSession returns proxyUrl already with the stored sticky
// session ID baked in (oxylabs `customer-X-cc-us-sessid-N` etc). Only
// override when:
//   (a) no proxyUrl came back (account never registered with a proxy), OR
//   (b) the stored proxy is NOT a static ISP host (Residential triggers the
//       PX challenge per 2026-05-06 probe).
// The override path generates a fresh sessId by design — ONLY first login or
// recovery after the registration sticky burned. Steady-state logins must
// hit the same exit IP as the prior successful login.
// Any static-residential ISP host counts (Decodo isp.decodo.com canonical
// since 2026-05-21, plus legacy isp.oxylabs.io / disp.oxylabs.io for accounts
// still pinned there). The generic 'isp us' filter on the fresh-pick path
// lets the canonical Decodo win by being first in the providers list.
const STATIC_ISP_RE = /(^|\.)(isp\.oxylabs\.io|disp\.oxylabs\.io|isp\.decodo\.com)$/i;

export function isStaticIsp(url) {
  if (!url) return false;
  try { return STATIC_ISP_RE.test(new URL(url).hostname); } catch { return false; }
}

/**
 * The proxy URL this login runs through: the account's stored static ISP
 * sticky when it has one, else a freshly resolved US ISP exit. Exits the
 * process when no static ISP proxy can be resolved at all.
 */
export async function chooseLoginProxy(storedProxyUrl, username) {
  if (isStaticIsp(storedProxyUrl)) {
    console.log(`[linkedin_login] reusing stored static ISP sticky for ${username}`);
    return storedProxyUrl;
  }
  console.log(`[linkedin_login] stored proxy not static ISP — picking fresh`);
  const pw = await resolveProxy('isp us', 'www.linkedin.com');
  if (!(pw?.server && pw?.username)) {
    console.log(`[linkedin_login] FAIL: no static ISP proxy resolved`);
    process.exit(2);
  }
  const u = new URL(pw.server);
  u.username = encodeURIComponent(pw.username);
  u.password = encodeURIComponent(pw.password ?? '');
  console.log(`[linkedin_login] picked isp proxy ${pw.server}`);
  return u.toString();
}
