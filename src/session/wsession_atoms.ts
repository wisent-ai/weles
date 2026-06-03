/**
 * Shared interaction atoms on WSession. Added via prototype augmentation so
 * wsession.ts stays under its 300-line cap. Each atom replaces a pattern
 * duplicated 5+ times across trajectories (see docs/DETECTION_ANTIPATTERNS.md).
 *
 * wsession.ts calls installAtoms(WSession) at the bottom of its module so
 * the class is fully defined before prototype assignment runs. Side-effect
 * import was the previous shape but breaks under CJS circular load.
 */
import type { WSession } from './wsession.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from './run-recordings.js';

declare module './wsession.js' {
  interface WSession {
    waitFor(selector: string, opts?: { state?: 'attached' | 'visible' | 'hidden' | 'detached'; timeoutMs?: number }): Promise<string>;
    fillSelector(css: string, value: string): Promise<string>;
    writeBanSignal(banSignal: Record<string, unknown>, extras?: Record<string, unknown>): void;
    dismissCookieBanner(platform?: string): Promise<string>;
    dwell(scrolls: number, dwellMsRange?: [number, number]): Promise<string>;
    patchAccount(accountId: string, patch: Record<string, unknown>): Promise<boolean>;
    isLoggedOut(platform?: string): Promise<boolean>;
  }
}

// Per-platform button-text lookup for dismissCookieBanner. First match wins.
// Kept narrow (≤4 entries each) to respect the inline-array budget; if a new
// platform needs more variants, promote them to a constants file.
const COOKIE_BANNER_TEXTS: Record<string, string[]> = {
  reddit:    ['refuse non-essential cookies', 'accept all', 'accept'],
  tiktok:    ['decline optional cookies', 'accept all'],
  instagram: ['allow essential', 'allow all cookies', 'decline optional'],
  linkedin:  ['accept cookies', 'decline'],
  discord:   ['accept cookies', 'ok'],
  github:    ['accept cookies'],
  twitter:   ['refuse non-essential cookies', 'accept all cookies'],
  default:   ['refuse non-essential cookies', 'decline optional', 'allow essential', 'accept all'],
};

const LOGGED_OUT_SELECTORS: Record<string, string> = {
  reddit:    'a[href*="/login"]',
  tiktok:    'button:has-text("Log in"), a[href*="/login"]',
  instagram: 'button:has-text("Log in"), a[href="/accounts/login/"]',
  linkedin:  'a[href*="/login"], a[href*="/uas/login"]',
  discord:   'a[href="/login"]',
  github:    'a[href="/login"]',
  twitter:   'a[href="/login"], [data-testid="loginButton"]',
  default:   'a[href*="/login"], a[href*="/signin"], button:has-text("Log in"), button:has-text("Sign in")',
};

export function installAtoms(W: typeof import('./wsession.js').WSession): void {
W.prototype.waitFor = function (selector, opts) {
  const state = opts?.state ?? 'visible';
  const timeout = opts?.timeoutMs ?? 30000;
  return this.runStep(`waitFor_${selector.slice(0, 30)}`, async () => {
    try { await (this as WSession).page.locator(selector).first().waitFor({ state, timeout }); return `waited ${state}: ${selector.slice(0, 60)}`; }
    catch { return `timeout ${state}: ${selector.slice(0, 60)}`; }
  });
};

W.prototype.fillSelector = function (css, value) {
  return this.runStep(`fillSel_${css.slice(0, 30)}`, async () => {
    const v = (this as WSession).resolveEnv(value);
    const loc = (this as WSession).page.locator(css).first();
    if (!(await loc.count())) return 'no-element-found';
    await loc.fill(v);
    return `filled ${css.slice(0, 60)}`;
  });
};

W.prototype.writeBanSignal = function (banSignal, extras) {
  const self = this as WSession;
  if (!self.label) return;
  const dir = runRecordingsDir(self.label); // G17: recordings/<run_uuid>/<label>/
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'ban_signal.json'),
      JSON.stringify({ ...banSignal, ...(extras ?? {}), ts: new Date().toISOString() }, null, 2),
    );
  } catch { /* swallow — best-effort sidecar write */ }
};

W.prototype.dismissCookieBanner = async function (platform) {
  const key = (platform ?? (this as WSession).label.split('_')[0]).toLowerCase();
  const texts = COOKIE_BANNER_TEXTS[key] ?? COOKIE_BANNER_TEXTS.default;
  for (const t of texts) {
    const r = await (this as WSession).jsClick('button, [role="button"], a', t).catch(() => 'no-element-found');
    if (r && !/no-element-found/.test(r)) return `dismissed (${key}: ${t})`;
  }
  return 'no-banner-found';
};

W.prototype.dwell = async function (scrolls, dwellMsRange) {
  const [minMs, maxMs] = dwellMsRange ?? [1500, 3500];
  return this.runStep(`dwell_${scrolls}x`, async () => {
    const self = this as WSession;
    for (let i = 0; i < scrolls; i++) {
      await self.page.evaluate(`window.scrollBy(0, ${300 + Math.floor(Math.random() * 200)})`).catch(() => {});
      await new Promise((r) => setTimeout(r, minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs))));
    }
    return `dwelled ${scrolls}x`;
  });
};

W.prototype.patchAccount = async function (accountId, patch) {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key || !accountId) return false;
  try {
    const getRes = await fetch(`${url}/rest/v1/social_accounts?id=eq.${accountId}&select=metadata`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await getRes.json() as any[];
    const currentMeta = rows?.[0]?.metadata ?? {};
    const mergedMeta = 'metadata' in patch ? { ...currentMeta, ...(patch.metadata as Record<string, unknown>) } : currentMeta;
    const body = { ...patch, ...('metadata' in patch ? { metadata: mergedMeta } : {}) };
    const res = await fetch(`${url}/rest/v1/social_accounts?id=eq.${accountId}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch { return false; }
};

W.prototype.isLoggedOut = async function (platform) {
  const key = (platform ?? (this as WSession).label.split('_')[0]).toLowerCase();
  const sel = LOGGED_OUT_SELECTORS[key] ?? LOGGED_OUT_SELECTORS.default;
  try { return (await (this as WSession).page.locator(sel).first().count()) > 0; }
  catch { return false; }
};
}
