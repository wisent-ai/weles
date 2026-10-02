import { resolveProxy } from '../../../../dist/proxy/config.js';

// Preserve the account's stored connection identity for subsequent logins.
//
// resolveAccountSession returns proxyUrl already with the stored sticky
// session ID baked in (oxylabs `customer-X-cc-us-sessid-N` etc). Only
// override when:
//   (a) no proxyUrl came back (account never registered with a proxy), OR
//   (b) the stored proxy is not a static ISP host.
// The override path generates a fresh sessId by design — ONLY first login or
// recovery after the registration sticky burned. Steady-state logins must
// hit the same exit IP as the prior successful login.
// Any static-residential ISP host counts (Decodo isp.decodo.com canonical,
// plus legacy isp.oxylabs.io / disp.oxylabs.io for accounts
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
