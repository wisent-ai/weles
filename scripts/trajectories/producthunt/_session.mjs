// Shared session helpers for ProductHunt trajectories.
//
// Everything here runs inside a WSession. Cross-platform OAuth primitives
// (cookie injection, consent-dialog loop, captcha-gate clear) live in
// src/platforms/_shared/cross_platform_oauth.ts — this file only composes
// them into the PH-specific click sequence.

import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';
import {
  injectProviderCookies,
  handleOAuthConsent,
  waitForNavBackTo,
  clearReCaptchaGate,
  clickOAuthProviderButton,
} from '../../../dist/platforms/_shared/cross_platform_oauth.js';

const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));

// PH-specific: PH cookies still need their own injector because the "provider"
// here is the target site, not an OAuth source. The cross_platform_oauth
// helper handles OAuth-provider cookies (.x.com, .instagram.com, etc.).
export async function injectPHCookies(s, cookies) {
  const norm = cookies
    .filter(c => c.name && c.value)
    .map(c => ({
      name: c.name, value: c.value,
      domain: c.domain?.includes('producthunt.com') ? c.domain : '.producthunt.com',
      path: c.path || '/', secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false, sameSite: c.sameSite || 'Lax',
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
    }));
  await s.ctx.addCookies(norm);
  return norm.length;
}

// Pick the first product launch URL from the PH homepage. Both upvote and
// comment trajectories need a /products/<slug> URL because that's the only
// page shape that renders both the vote button and the tiptap composer
// (verified 2026-05-02 via .work/ph-probe). Returns null if nothing
// suitable is found — callers should treat that as a soft fail and skip.
export async function pickFirstProductLaunchUrl(s) {
  // Prefer /products/<slug> — verified via .work/ph-probe to be the only
  // page shape with both the upvote button and the tiptap composer.
  // /posts/new is the "submit launch" form (no composer), /posts/<id> is
  // the legacy URL that PH 308-redirects to /products/<slug>.
  const href = await s.page.evaluate(`(() => {
    function pick(prefix) {
      var as = Array.from(document.querySelectorAll('a[href*="' + prefix + '"]'));
      for (var a of as) {
        var h = a.getAttribute('href') || '';
        if (h.includes('?ref=footer')) continue;
        if (h.includes('/reviews')) continue;
        if (h.includes('/alternatives')) continue;
        var slug = (h.match(new RegExp('\\\\' + prefix + '([^/?#]+)')) || [])[1];
        if (!slug) continue;
        if (slug === 'new' || slug === 'launching-soon' || slug === 'all') continue;
        return h;
      }
      return null;
    }
    return pick('/products/') || pick('/posts/');
  })()`).catch(() => null);
  if (!href) return null;
  return href.startsWith('http') ? href : new URL(href, 'https://www.producthunt.com').toString();
}

// Discover the authed user's PH handle. Two failures observed during
// register: the homepage often returns the SSR logged-out shell right
// after OAuth (the new session cookie isn't reflected in the cached
// response), so polling the topbar there can sit empty for 16s+.
// Strategy: bounce between the homepage, /my/notifications (auth-walled,
// redirects authed users to a path containing the handle), and
// /products/<latest-launch> (always renders the topbar avatar). First
// /@<handle> hit anywhere wins.
export async function extractPhHandle(s) {
  const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));
  const TARGETS = ['https://www.producthunt.com/', 'https://www.producthunt.com/my/notifications'];
  for (let i = 0; i < 6; i++) {
    const url = TARGETS[i % TARGETS.length];
    try { await s.page.goto(url); } catch {}
    await sleep(3);
    const handle = await s.page.evaluate(() => {
      const selectors = [
        'a[data-test^="user-image-link-"]',
        'header a[href^="/@"]',
        'a[href*="/@"][data-test*="user"]',
        'a[href^="/@"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const href = el?.getAttribute('href') || '';
        const m = href.match(/\/@([^/?#]+)/);
        if (m) return m[1];
      }
      const urlMatch = location.href.match(/\/@([^/?#]+)/);
      if (urlMatch) return urlMatch[1];
      return null;
    }).catch(() => null);
    if (handle) return handle;
  }
  return null;
}

// Pick a Twitter account suitable for SSO into a fresh PH registration.
// Prefers Twitter accounts whose username is NOT already linked to any PH
// row — running OAuth from an already-linked Twitter just re-authenticates
// the existing PH user (PH binds 1:1 by Twitter source). Tracks linkage
// via PH row metadata.linked_twitter_username (set by stampLinkedTwitter
// below) AND a legacy match on PH row username for pre-handle-fix rows.
export async function findUsableTwitterAccount() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return null;
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const linkedTwitter = new Set();
  try {
    const phRows = await fetch(
      `${supabaseUrl}/rest/v1/social_accounts?platform=eq.producthunt&select=username,metadata`,
      { headers },
    ).then(r => r.ok ? r.json() : []);
    for (const ph of phRows) {
      const lt = ph?.metadata?.linked_twitter_username;
      if (typeof lt === 'string' && lt) linkedTwitter.add(lt.toLowerCase());
      if (typeof ph?.username === 'string') linkedTwitter.add(ph.username.toLowerCase());
    }
  } catch {}
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?platform=eq.twitter&is_active=eq.true&select=id,platform,username,metadata&order=created_at.desc&limit=50`,
    { headers },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  const isUnlinked = (a) => !linkedTwitter.has(String(a.username || '').toLowerCase());
  for (const a of rows) {
    const hasCookies = Array.isArray(a.metadata?.cookies) && a.metadata.cookies.length >= 2;
    const suspended = String(a.metadata?.status ?? '').toLowerCase().includes('suspend');
    const locked = String(a.metadata?.status ?? '').toLowerCase().includes('lock');
    if (hasCookies && !suspended && !locked && isUnlinked(a)) return a;
  }
  for (const a of rows) {
    if (Array.isArray(a.metadata?.cookies) && a.metadata.cookies.length >= 2 && isUnlinked(a)) return a;
  }
  for (const a of rows) {
    const hasCookies = Array.isArray(a.metadata?.cookies) && a.metadata.cookies.length >= 2;
    const suspended = String(a.metadata?.status ?? '').toLowerCase().includes('suspend');
    const locked = String(a.metadata?.status ?? '').toLowerCase().includes('lock');
    if (hasCookies && !suspended && !locked) return a;
  }
  return rows[0] ?? null;
}

// Stamp linked_twitter_username on the PH row that saveAccount just inserted,
// so future findUsableTwitterAccount() calls can skip this Twitter.
export async function stampLinkedTwitter(phUsername, twUsername) {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return;
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?platform=eq.producthunt&username=eq.${encodeURIComponent(phUsername)}&select=id,metadata`,
    { headers },
  );
  if (!res.ok) return;
  const rows = await res.json();
  if (!rows[0]) return;
  const merged = { ...(rows[0].metadata ?? {}), linked_twitter_username: twUsername };
  await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?id=eq.${rows[0].id}`,
    { method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: merged }) },
  ).catch(() => {});
  console.log(`[ph] stamped linked_twitter_username="${twUsername}" on PH row id=${rows[0].id}`);
}

// Drive the PH-specific Twitter SSO click sequence. All cross-platform
// primitives (cookies, consent, captcha) come from _shared/.
export async function loginViaTwitter(s) {
  const tw = await getSocialAccount('twitter');
  if (!tw) throw new Error('no_twitter_account');
  const twCookies = tw.metadata?.cookies ?? [];
  if (twCookies.length < 2) throw new Error('twitter_account_missing_cookies');
  console.log(`[ph-session] OAuth via twitter account ${tw.username}`);
  await injectProviderCookies(s.ctx, 'twitter', twCookies);

  await s.goto('https://www.producthunt.com/');
  await sleep(3);
  await s.click('Sign in').catch(() => {});
  await sleep(2);
  // Deterministic accessible-name match — avoids vision misreading the adjacent
  // Google/Apple buttons in the provider list at larger viewports.
  const twitterLabel = /^\s*(Sign in with X|Continue with X|Sign up with Twitter|Continue with Twitter)\s*$/i;
  const clickedTw = await clickOAuthProviderButton(s, twitterLabel);
  if (!clickedTw) {
    await s.click('Sign in with X').catch(() => {});
    await s.click('Continue with Twitter').catch(() => {});
  }
  await sleep(6);

  await handleOAuthConsent(s);
  await waitForNavBackTo(s.page, 'producthunt.com', ['/auth/', 'twitter.com', 'x.com'], 40);

  const cleared = await clearReCaptchaGate(s, new CaptchaSolver(), '/captcha_verification');
  if (!cleared) throw new Error('captcha_gate_not_cleared');
  return true;
}
