/**
 * WSession close + persistence + I/O helpers extracted to keep wsession.ts
 * under the 300-line cap. Logic identical to the pre-2026-05-02 inlined
 * version EXCEPT for the proxy-bytes provider classifier in wsClose, which
 * now prefers session.proxyConfig.provider before falling back to host
 * substring matching. resolveProxy DNS-resolves the proxy hostname and stores
 * the IP literal in proxyConfig.server, so host.includes('brightdata') always
 * returned false on resolved-IP servers and every BD session bucketed as
 * proxy_other in cost_records — fixed here so account_action_logs.service_costs
 * gets the key 'brightdata' (or oxylabs / packetstream / etc) and a per-row
 * sum against the budget shows real BD spend.
 */

import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { costTracker } from '../../utils/cost.js';
import { markSignupSuccess } from '../../utils/email/domain.js';
import { getEmailApiKey } from '../../utils/credentials.js';
import { humanClick, humanClickLocator } from '../../human/mouse.js';
import { humanType } from '../../human/keyboard.js';
import { findClickTarget, type ScreenshottablePage } from '../../vision/analyze.js';
import type { WSession } from '../wsession.js';

const VISIBILITY_PROBE_MS = 1500;

const asV = (p: any) => p as unknown as ScreenshottablePage;

function recordingsDir(label?: string): string {
  const d = join(process.cwd(), 'recordings', ...(label ? [label] : []));
  mkdirSync(d, { recursive: true });
  return d;
}

function profileUrl(platform: string, username: string, name?: string): string {
  const urls: Record<string, string> = {
    reddit: `https://reddit.com/u/${username}`,
    tiktok: `https://tiktok.com/@${username}`,
    github: `https://github.com/${username}`,
    discord: `https://discord.com/users/${username}`,
    linkedin: `https://linkedin.com/in/${(name ?? username).toLowerCase().replace(/\s+/g, '-')}`,
    instagram: `https://instagram.com/${username}`,
    twitter: `https://x.com/${username}`,
  };
  return urls[platform] ?? '';
}

export async function wsClick(s: WSession, target: string): Promise<string> {
  return s.runStep(`click_${target}`, async () => {
    const tryLoc = async (loc: any, descPrefix: string): Promise<string | null> => {
      try {
        if ((await loc.count?.()) > 0 && await loc.first().isVisible({ timeout: VISIBILITY_PROBE_MS }).catch(() => false)) {
          await humanClickLocator(s.page, loc.first());
          return `clicked ${descPrefix}${target}`;
        }
      } catch {}
      return null;
    };
    const tEsc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reExact = new RegExp(`^\\s*${tEsc}\\s*$`, 'i');
    const reLoose = new RegExp(tEsc, 'i');
    for (const role of ['button', 'link', 'checkbox'] as const) {
      try { const r = await tryLoc(s.page.getByRole(role, { name: reExact }), `${role}: `); if (r) return r; } catch {}
    }
    for (const role of ['button', 'link'] as const) {
      try { const r = await tryLoc(s.page.getByRole(role, { name: reLoose }), `${role}: `); if (r) return r; } catch {}
    }
    const marker = `weles-click-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const c = await s.page.evaluate(`(()=>{function F(r,s){var a=Array.from(r.querySelectorAll(s));r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot)a=a.concat(F(e.shadowRoot,s))});return a}function vis(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0&&el.offsetParent!==null}var t=${JSON.stringify(target.toLowerCase().trim())};var m=${JSON.stringify(marker)};var sr=F(document,'[data-post-click-location] button');if(t.indexOf('upvote')>=0&&sr.length>0){sr[0].setAttribute('data-weles-click',m);return{desc:'upvote (shadow)'}}var bs=F(document,'button,a,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[data-e2e],label,input[type="checkbox"],[role="checkbox"]');var exact=null,partial=null;for(var i=0;i<bs.length;i++){var el=bs[i];var txt=((el.textContent||'').trim()+' '+(el.getAttribute('aria-label')||'').trim()).toLowerCase().trim();var visi=vis(el);if(!visi)continue;if(txt===t||txt.split(' ').join(' ')===t){exact=el;break}if(!partial&&txt.indexOf(t)>=0){partial=el}}var hit=exact||partial;if(!hit)return null;var cb=hit.querySelector('input[type="checkbox"]')||hit;cb.setAttribute('data-weles-click',m);var d=((hit.textContent||'').trim()||(hit.getAttribute('aria-label')||'')).slice(0,40);return{desc:(exact?'exact:':'partial:')+d}})()`).catch(() => null);
    if (c) {
      const loc = s.page.locator(`[data-weles-click="${marker}"]`).first();
      try { await humanClickLocator(s.page, loc); }
      finally { await s.page.evaluate(`(()=>{document.querySelectorAll('[data-weles-click=${JSON.stringify(marker)}]').forEach(e=>e.removeAttribute('data-weles-click'))})()`).catch(() => {}); }
      return `clicked ${(c as any).desc ?? target}`;
    }
    const coords = await findClickTarget(asV(s.page), target);
    if (coords) { await humanClick(s.page, coords.x, coords.y); return `clicked ${target} (vision)`; }
    return 'no-target-found';
  });
}

export async function wsFill(s: WSession, target: string, value: string): Promise<string> {
  return s.runStep(`fill_${target}`, async () => {
    const v = s.resolveEnv(value);
    const { humanFill } = await import('../../human/keyboard.js');
    try { const lbl = s.page.getByLabel?.(target, { exact: false })?.first?.(); if (lbl && await lbl.isVisible({ timeout: VISIBILITY_PROBE_MS }).catch(() => false)) { await humanFill(s.page, lbl, v); return 'filled'; } } catch {}
    const kws = target.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
    const sels = kws.flatMap(k => ['input','textarea','[contenteditable]'].flatMap(t => [`${t}[name*="${k}"]`,`${t}[placeholder*="${k}" i]`,`${t}[aria-label*="${k}" i]`]));
    for (const sel of sels) { try { const el = s.page.locator?.(sel)?.first?.(); if (el && await el.isVisible()) { await humanFill(s.page, el, v); return 'filled'; } } catch {} }
    const tgt = JSON.stringify(target.toLowerCase());
    const c = await s.page.evaluate(`(()=>{var t=${tgt};for(var el of document.querySelectorAll('*')){var r=el.getBoundingClientRect();var ph=(el.getAttribute('placeholder')||'').toLowerCase();if(r.width>50&&r.height>10&&r.x>0&&ph&&ph.indexOf(t)>=0)return{x:r.x+r.width/2,y:r.y+r.height/2}}return null})()`).catch(() => null);
    if (c) { await humanClick(s.page, c.x, c.y); await s.page.keyboard.press('Meta+a').catch(() => {}); await humanType(s.page, v); return 'filled'; }
    const vc = await findClickTarget(asV(s.page), target);
    if (vc) { await humanClick(s.page, vc.x, vc.y); await s.page.keyboard.press('Meta+a').catch(() => {}); await humanType(s.page, v); return 'filled'; }
    return 'no-field-found';
  });
}

export async function wsCheckEmail(s: WSession, email: string, sender: string): Promise<string> {
  const key = await getEmailApiKey() ?? '';
  if (!key) return 'error: no RESEND_RECEIVING_API_KEY';
  const addr = s.resolveEnv(email).toLowerCase();
  const earliestAcceptMs = Date.now() - 90_000;
  for (let i = 0; i < 30; i++) {
    const r = await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${key}` } });
    for (const em of ((await r.json()) as any).data ?? []) {
      const to = (em.to ?? []).map((t: any) => (typeof t === 'string' ? t : t.email ?? '').toLowerCase());
      if (!to.includes(addr)) continue;
      if (sender && !(em.from ?? '').toLowerCase().includes(sender)) continue;
      const emAt = em.created_at ? new Date(em.created_at).getTime() : 0;
      if (emAt < earliestAcceptMs) continue;
      const d = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${key}` } })).json() as any;
      const codes = `${d.subject ?? ''} ${d.text ?? ''} ${d.html ?? ''}`.match(/\b\d{5,6}\b/g);
      if (codes) return codes[0];
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  return 'no code received';
}

export async function wsSaveAccount(
  s: WSession,
  platform: string,
  data: { username: string; email: string; password: string; name?: string; status?: string },
): Promise<string> {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '';
  if (!url || !key) return 'error: no SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY';
  const username = s.resolveEnv(data.username);
  const email = s.resolveEnv(data.email);
  const password = s.resolveEnv(data.password);
  const name = data.name ? s.resolveEnv(data.name) : undefined;
  const storageState = await s.ctx.storageState().catch(() => ({ cookies: [] as any[], origins: [] as any[] }));
  const cookies = (storageState as any).cookies ?? [];
  const row = {
    platform,
    username,
    display_name: name,
    profile_url: profileUrl(platform, username, name),
    metadata: {
      email, password, status: data.status ?? 'created', created_via: 'weles',
      cookies, storage_state: storageState,
      cookies_updated_at: new Date().toISOString(),
      cookies_minted_at: new Date().toISOString(),
      cookies_minted_proxy: (s as any)._proxySignature(),
      cookies_minted_persona: (s as any)._personaSignature(),
      proxy: s.proxyConfig ?? null,
      persona: (s as any).personaConfig ?? null,
    },
    is_active: true,
    created_by: 'weles',
  };
  const res = await fetch(`${url}/rest/v1/social_accounts`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) return `error: ${res.status} ${await res.text().catch(() => '')}`;
  try {
    const r = await res.json();
    writeFileSync(join(recordingsDir(s.label || undefined), 'account.json'), JSON.stringify(Array.isArray(r) ? r[0] : r, null, 2));
  } catch {}
  await markSignupSuccess(email, platform).catch(() => {});
  return `account saved: ${platform}/${username}`;
}

export async function wsClose(s: WSession): Promise<void> {
  const proxyBytes: number = (s as any)._proxyBytes;
  console.log(`[wsession] close() label=${s.label} proxy_bytes=${proxyBytes}`);
  if (proxyBytes > 0) {
    try {
      const cfg = s.proxyConfig;
      const server = cfg?.server;
      if (server) {
        const host = new URL(server).hostname.toLowerCase();
        const isMobile = /mobile/.test(host) || (cfg as any)?.platform?.toLowerCase().includes('mobile') === true;
        // Prefer the .provider field set by resolveProxy at config.ts:127,293.
        // host.includes(...) is a safety net for proxyConfig values that never
        // went through resolveProxy and lack .provider (custom PROXY_URL).
        const provider = (cfg as any)?.provider
          || (host.includes('packetstream') ? 'packetstream'
            : host.includes('oxylabs') ? 'oxylabs'
            : host.includes('pingproxies') || host.includes('pingproxy') ? 'pingproxies'
            : host.includes('iproyal') ? 'iproyal'
            : host.includes('brd.superproxy') || host.includes('brightdata') ? 'brightdata'
            : 'other');
        costTracker.recordProxyBytes(provider, proxyBytes, isMobile);
      } else {
        costTracker.recordProxyBytes('other', proxyBytes);
      }
    } catch (e: any) { console.log(`[wsession] proxy-bytes record err: ${e.message?.slice(0, 100)}`); }
  }
  try { await (s as any)._cdp?.detach?.(); } catch {}
  await (s as any)._cap.save('session', s.page).catch(() => {});
  try { writeFileSync(join(recordingsDir(s.label || undefined), 'network.ndjson'), s.capturedResponses.map(r => JSON.stringify(r)).join('\n')); } catch {}
  if (process.env.WELES_INSTRUMENT === '1' && !s.page.isClosed?.()) {
    try {
      const j: string = await s.page.evaluate('(window.__inst_flush)?window.__inst_flush():"[]"');
      const outDir = join(process.cwd(), '.work', 'inst');
      mkdirSync(outDir, { recursive: true });
      const fn = join(outDir, `${s.label || 'session'}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(fn, j);
      console.log(`[wsession] dumped __inst ${j.length}ch -> ${fn}`);
    } catch (e: any) { console.log(`[wsession] __inst dump err: ${e.message?.slice(0,120)}`); }
  }
  const video = s.page.video?.();
  const dest = join(recordingsDir(s.label || undefined), `${s.label || 'session'}_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);
  console.log(`[wsession] close() video=${!!video} dest=${dest}`);
  await s.page.close().catch((e: any) => console.log(`[wsession] page.close error: ${e.message?.slice(0, 200)}`));
  if (video) {
    await video.saveAs(dest).catch((e: any) => {
      console.log(`[wsession] video.saveAs error: ${e.message?.slice(0, 200)}`);
      try { const src = video.path?.() as string | undefined; if (src) { copyFileSync(src, dest); console.log(`[wsession] video copied from ${src}`); } } catch {}
    });
  }
  await s.ctx.close().catch((e: any) => console.log(`[wsession] ctx.close error: ${e.message?.slice(0, 200)}`));
  await costTracker.flush().catch(() => {});
  console.log(`[wsession] close() done`);
}
