// Cross-platform OAuth helpers.
//
// Pattern: use stored cookies from an account on platform A to OAuth-sign-in
// to platform B (e.g. Twitter account -> ProductHunt, Instagram account ->
// Threads). Before this module, each trajectory re-implemented cookie domain
// normalization, OAuth-consent click loops, and the reCAPTCHA-gate submit
// trick inline. Those live here now.

import { pageSettled } from '../../browser/settled.js';

type BrowserCtx = any;
type PageLike = any;
type SessionLike = any;

interface ProviderConfig { primaryDomain: string; mirrorDomains?: string[]; }

const PROVIDER_DOMAINS: Record<string, ProviderConfig> = {
  twitter: { primaryDomain: '.x.com', mirrorDomains: ['.twitter.com'] },
  instagram: { primaryDomain: '.instagram.com' },
  google: { primaryDomain: '.google.com', mirrorDomains: ['.youtube.com', '.accounts.google.com'] },
  facebook: { primaryDomain: '.facebook.com', mirrorDomains: ['.messenger.com'] },
  github: { primaryDomain: '.github.com' },
  apple: { primaryDomain: '.apple.com', mirrorDomains: ['.icloud.com'] },
  microsoft: { primaryDomain: '.microsoftonline.com', mirrorDomains: ['.live.com', '.microsoft.com', '.login.microsoft.com'] },
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

/**
 * Click a deterministic OAuth-provider button by its accessible name — avoids
 * the vision-based match in WSession.click, which at larger viewports has been
 * misreading adjacent provider buttons (e.g. 2560x1600 PH signin modal hits
 * "Sign in with Google" when asked for "Sign in with X"). Returns true on
 * a confirmed click, false if no matching button/link was visible.
 */
export async function clickOAuthProviderButton(s: SessionLike, accessibleName: RegExp): Promise<boolean> {
  const page = s.page;
  for (const role of ['button', 'link']) {
    const el = page.getByRole(role, { name: accessibleName }).first();
    const visible = await el.isVisible();
    if (visible) { await el.click(); return true; }
  }
  return false;
}

/** Click the consent button while still on an OAuth consent URL. Each consent screen is answered once: the walk ends as soon as the URL leaves the /auth//oauth//authorize subtree, when the page shows no button to consent with, or when a click leaves the page on the same consent URL. The button's accessible name is read through the page's accessibility tree, not from the page's text. */
export async function handleOAuthConsent(s: SessionLike): Promise<void> {
  for (;;) {
    const u: string = s.page.url?.() ?? '';
    if (u && !/\/auth\/|\/oauth\/|\/authorize/i.test(u)) return;
    const clicked = await clickOAuthProviderButton(s, /^(authorize app|authorize|allow)$/i);
    if (!clicked) return;
    await pageSettled(s.page);
    if ((s.page.url?.() ?? '') === u) {
      console.log(`[oauth] oauth_consent_not_accepted: the consent click left the page on ${u}`);
      return;
    }
  }
}

/** Wait until the page URL includes mustInclude and excludes every mustExcludeAny substring. */
export async function waitForNavBackTo(page: PageLike, mustInclude: string, mustExcludeAny: string[]): Promise<void> {
  await page.waitForURL((url: URL) => {
    const u = String(url);
    return u.includes(mustInclude) && !mustExcludeAny.some((x) => u.includes(x));
  });
}

/**
 * Clear a reCAPTCHA v2 gate page. Detects captcha via src/captcha/detect.ts,
 * solves the token, then triggers the page's React form.onSubmit by calling
 * form.requestSubmit() — which is what producthunt's captcha_verification
 * page (and similar SPA captcha gates) needs to run its Apollo mutation.
 */
export async function clearReCaptchaGate(s: SessionLike, solver: any, gateUrlSubstring: string): Promise<boolean> {
  const { solvePageCaptcha } = await import('../../captcha/detect.js');
  // One solve: a second token on the same gate is the same answer to a page
  // that already refused it.
  if (!(s.page.url?.() ?? '').includes(gateUrlSubstring)) return true;
  await s.page.waitForSelector('iframe[src*="recaptcha/api2/anchor"]');
  await pageSettled(s.page);
  const solved = await solvePageCaptcha(s.page, solver, s);
  if (!solved) return false;
  // Try button click first (more reliable than requestSubmit on PH's React
  // form), then form.requestSubmit, then a synthetic submit event.
  await s.page.evaluate(() => {
    const ta = document.getElementById('g-recaptcha-response') as HTMLTextAreaElement | null;
    if (!ta || !ta.value) return;
    const btn = document.querySelector('button[type="submit"], input[type="submit"]') as HTMLElement | null;
    if (btn) { btn.click(); return; }
    const form = document.querySelector('form') as HTMLFormElement | null;
    if (!form) return;
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
  await pageSettled(s.page);
  if (!(s.page.url?.() ?? '').includes(gateUrlSubstring)) return true;
  // Token's been written but the page didn't navigate. PH's verification
  // sets a server cookie on solve — re-issuing a navigation to the homepage
  // carries that cookie and lets the next request pass the gate.
  await s.page.goto('https://www.producthunt.com/');
  await pageSettled(s.page);
  if (!(s.page.url?.() ?? '').includes(gateUrlSubstring)) return true;
  console.log(`[oauth] recaptcha_gate_not_cleared: still on ${s.page.url?.() ?? ''}`);
  return false;
}
