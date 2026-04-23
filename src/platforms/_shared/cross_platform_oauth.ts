// Cross-platform OAuth helpers.
//
// Pattern: use stored cookies from an account on platform A to OAuth-sign-in
// to platform B (e.g. Twitter account -> ProductHunt, Instagram account ->
// Threads). Before this module, each trajectory re-implemented cookie domain
// normalization, OAuth-consent click loops, and the reCAPTCHA-gate submit
// trick inline. Those live here now.

type BrowserCtx = any;
type PageLike = any;
type SessionLike = any;

interface ProviderConfig { primaryDomain: string; mirrorDomains?: string[]; }

const PROVIDER_DOMAINS: Record<string, ProviderConfig> = {
  twitter: { primaryDomain: '.x.com', mirrorDomains: ['.twitter.com'] },
  instagram: { primaryDomain: '.instagram.com' },
  google: { primaryDomain: '.google.com' },
  facebook: { primaryDomain: '.facebook.com' },
  github: { primaryDomain: '.github.com' },
  apple: { primaryDomain: '.apple.com' },
};

export interface RawCookie {
  name?: string; value?: string; domain?: string; path?: string;
  secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number;
}

/**
 * Normalize raw cookie rows to the provider's primary and mirror domains and
 * add them to the browser context. Returns count added.
 *
 * `extraMirrorDomains` covers cross-property cases like Meta's instagram ->
 * threads.net where the sibling site accepts the same session cookies. Pass
 * mirrors with a leading dot (e.g. '.threads.net').
 */
export async function injectProviderCookies(
  ctx: BrowserCtx,
  provider: string,
  cookies: RawCookie[],
  opts: { extraMirrorDomains?: string[] } = {},
): Promise<number> {
  const cfg = PROVIDER_DOMAINS[provider];
  if (!cfg) throw new Error(`unknown_oauth_provider:${provider}`);
  const primary = cfg.primaryDomain;
  const normalized = cookies.filter(c => c.name && c.value).map(c => ({
    name: c.name!, value: c.value!,
    domain: c.domain?.startsWith('.') ? c.domain : (c.domain || primary),
    path: c.path || '/',
    secure: c.secure ?? true,
    httpOnly: c.httpOnly ?? false,
    sameSite: (c.sameSite || 'Lax') as any,
    ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
  }));
  const all = [...normalized];
  const mirrors = [...(cfg.mirrorDomains ?? []), ...(opts.extraMirrorDomains ?? [])];
  for (const mirror of mirrors) {
    const primaryBare = primary.startsWith('.') ? primary.slice(1) : primary;
    const mirrorBare = mirror.startsWith('.') ? mirror.slice(1) : mirror;
    all.push(...normalized.map(c => ({ ...c, domain: c.domain.replace(primaryBare, mirrorBare) })));
  }
  await ctx.addCookies(all);
  return all.length;
}

/** Click Authorize / Allow / Continue while still on an OAuth consent URL. Early-exits as soon as the URL leaves the /auth//oauth//authorize subtree. */
export async function handleOAuthConsent(s: SessionLike, maxAttempts: number = 3): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const u: string = s.page.url?.() ?? '';
    if (u && !/\/auth\/|\/oauth\/|\/authorize/i.test(u)) return;
    const text = await s.page.evaluate(() => (document.body?.innerText ?? '').toLowerCase().slice(0, 1000)).catch(() => '');
    if (!text.includes('authorize') && !text.includes('allow')) return;
    await s.click('Authorize app').catch(() => {});
    await s.click('Authorize').catch(() => {});
    await s.click('Allow').catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
  }
}

/** Poll until the page URL includes mustInclude and excludes every mustExcludeAny substring. */
export async function waitForNavBackTo(page: PageLike, mustInclude: string, mustExcludeAny: string[], seconds: number = 40): Promise<boolean> {
  for (let i = 0; i < seconds / 2; i++) {
    const u: string = page.url?.() ?? '';
    if (u.includes(mustInclude) && !mustExcludeAny.some(x => u.includes(x))) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Clear a reCAPTCHA v2 gate page. Detects captcha via src/captcha/detect.ts,
 * solves the token, then triggers the page's React form.onSubmit by calling
 * form.requestSubmit() — which is what producthunt's captcha_verification
 * page (and similar SPA captcha gates) needs to run its Apollo mutation.
 */
export async function clearReCaptchaGate(s: SessionLike, solver: any, gateUrlSubstring: string, maxAttempts: number = 3): Promise<boolean> {
  const { solvePageCaptcha } = await import('../../captcha/detect.js');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const u: string = s.page.url?.() ?? '';
    if (!u.includes(gateUrlSubstring)) return true;
    await s.page.waitForSelector('iframe[src*="recaptcha/api2/anchor"]').catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    const solved = await solvePageCaptcha(s.page, solver, s).catch(() => false);
    if (!solved) { await new Promise(r => setTimeout(r, 3000)); continue; }
    await s.page.evaluate(() => {
      const ta = document.getElementById('g-recaptcha-response') as HTMLTextAreaElement | null;
      if (!ta || !ta.value) return;
      const form = document.querySelector('form') as HTMLFormElement | null;
      if (!form) return;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 6000));
    if (!(s.page.url?.() ?? '').includes(gateUrlSubstring)) return true;
  }
  return false;
}
