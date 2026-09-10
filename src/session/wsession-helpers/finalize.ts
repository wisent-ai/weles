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

import type { Frame } from 'playwright';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { costTracker } from '../../utils/runtime/cost.js';
import { assertNonCredentialInput } from '../../utils/capability.js';
import { humanClick, humanClickLocator } from '../../human/mouse.js';
import { humanFill, humanType } from '../../human/keyboard.js';
import { findClickTarget, type ScreenshottablePage } from '../../vision/analyze.js';
import type { WSession } from '../wsession.js';
import { runRecordingsDir } from '../run-recordings.js';
import { recordingsDir, wsCaptureFingerprint } from './close/fingerprint_capture.js';

export { CREDENTIAL_FIELD_ABSENT, wsFillCredential, wsFillIdentity } from './close/credential_fill.js';
export { wsCheckEmail, wsSaveAccount } from './close/account_record.js';


const VISIBILITY_PROBE_MS = 1500;

const asV = (p: any) => p as unknown as ScreenshottablePage;

export function childFrames(s: WSession, allowedOrigin?: string): Frame[] {
  try {
    const frames: Frame[] = s.page.frames?.() ?? [];
    const mainFrame = s.page.mainFrame?.();
    return frames.filter((frame) => {
      if (frame === mainFrame) return false;
      if (!allowedOrigin) return true;
      try { return new URL(frame.url()).origin === allowedOrigin; }
      catch { return false; }
    });
  } catch {
    return [];
  }
}

export async function firstVisible(loc: any): Promise<any | null> {
  try {
    const first = loc?.first?.() ?? loc;
    let count = 1;
    if (typeof loc?.count === 'function') count = await loc.count().catch(() => 0);
    if (count > 0 && await first.isVisible({ timeout: VISIBILITY_PROBE_MS }).catch(() => false)) return first;
  } catch {}
  return null;
}


// G17: per-run layout — recordings/<run_uuid>/<label>/.
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
    const labelledButton = target.trim().match(/^button\[label=['"]([^'"]+)['"]\]/)?.[1];
    if (labelledButton) {
      const labelledExact = new RegExp(`^\\s*${labelledButton.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
      for (const frame of childFrames(s)) {
        const clicked = await tryLoc(frame.getByRole('button', { name: labelledExact }), 'frame button label: ');
        if (clicked) return clicked;
      }
      const clicked = await tryLoc(s.page.getByRole('button', { name: labelledExact }), 'button label: ');
      if (clicked) return clicked;
    }
    const explicitSelector = target.trim().match(/^(?:button|a|input|label|select|textarea|\[[^\]]+\])(?:\[[^\]]+\])*/)?.[0];
    if (explicitSelector) {
      for (const frame of childFrames(s)) {
        const clicked = await tryLoc(frame.locator(explicitSelector), 'frame selector: ');
        if (clicked) return clicked;
      }
      const clicked = await tryLoc(s.page.locator(explicitSelector), 'selector: ');
      if (clicked) return clicked;
    }
    const tEsc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reExact = new RegExp(`^\\s*${tEsc}\\s*$`, 'i');
    const reLoose = new RegExp(tEsc, 'i');
    for (const frame of childFrames(s)) {
      for (const role of ['button', 'link', 'checkbox', 'radio'] as const) {
        try { const r = await tryLoc(frame.getByRole(role, { name: reExact }), `frame ${role}: `); if (r) return r; } catch {}
      }
      for (const role of ['button', 'link', 'radio'] as const) {
        try { const r = await tryLoc(frame.getByRole(role, { name: reLoose }), `frame ${role}: `); if (r) return r; } catch {}
      }
      if (/\b(submit|send)\b/i.test(target)) {
        const submit = await firstVisible(frame.locator?.('input[type="submit"], button[type="submit"], button, [role="button"]'));
        if (submit) {
          await humanClickLocator(s.page, submit);
          return `clicked frame submit: ${target}`;
        }
      }
    }
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

export async function fillPage(s: WSession, target: string, value: string, allowedOrigin?: string): Promise<string> {
  const v = value;
  const explicitSelector = target.trim().match(/^(?:input|textarea)(?:\[[^\]]+\])+/)?.[0];
  const description = explicitSelector ? target.slice(explicitSelector.length) : target;
  const kws = description.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const sels = kws.flatMap(k => ['input','textarea','[contenteditable]'].flatMap(t => [`${t}[name*="${k}"]`,`${t}[placeholder*="${k}" i]`,`${t}[aria-label*="${k}" i]`]));
  if (/\b(email|e-mail)\b/i.test(target)) {
    sels.unshift('input[type="email"], input[name*="email" i], input[name*="mail" i], input[autocomplete*="email" i]');
  }
  for (const frame of childFrames(s, allowedOrigin)) {
    if (explicitSelector) {
      try {
        const explicit = await firstVisible(frame.locator?.(explicitSelector));
        if (explicit) { await humanFill(s.page, explicit, v); return `filled frame ${explicitSelector}`; }
      } catch {}
    }
    try { const lbl = await firstVisible(frame.getByLabel?.(target, { exact: false })); if (lbl) { await humanFill(s.page, lbl, v); return 'filled frame label'; } } catch {}
    for (const sel of sels) {
      try { const el = await firstVisible(frame.locator?.(sel)); if (el) { await humanFill(s.page, el, v); return `filled frame ${sel}`; } } catch {}
    }
  }
  if (explicitSelector) {
    try {
      const explicit = s.page.locator?.(explicitSelector)?.first?.();
      if (explicit && await explicit.isVisible()) { await humanFill(s.page, explicit, v); return `filled ${explicitSelector}`; }
    } catch {}
  }
  try { const lbl = s.page.getByLabel?.(target, { exact: false })?.first?.(); if (lbl && await lbl.isVisible({ timeout: VISIBILITY_PROBE_MS }).catch(() => false)) { await humanFill(s.page, lbl, v); return 'filled'; } } catch {}
  for (const sel of sels) { try { const el = s.page.locator?.(sel)?.first?.(); if (el && await el.isVisible()) { await humanFill(s.page, el, v); return 'filled'; } } catch {} }
  const tgt = JSON.stringify(target.toLowerCase());
  const c = await s.page.evaluate(`(()=>{var t=${tgt};for(var el of document.querySelectorAll('*')){var r=el.getBoundingClientRect();var ph=(el.getAttribute('placeholder')||'').toLowerCase();if(r.width>50&&r.height>10&&r.x>0&&ph&&ph.indexOf(t)>=0)return{x:r.x+r.width/2,y:r.y+r.height/2}}return null})()`).catch(() => null);
  if (c) { await humanClick(s.page, c.x, c.y); await s.page.keyboard.press('Meta+a').catch(() => {}); await humanType(s.page, v); return 'filled'; }
  const vc = await findClickTarget(asV(s.page), target);
  if (vc) { await humanClick(s.page, vc.x, vc.y); await s.page.keyboard.press('Meta+a').catch(() => {}); await humanType(s.page, v); return 'filled'; }
  return 'no-field-found';
}

export async function wsFill(s: WSession, target: string, value: string): Promise<string> {
  const pageUrl = new URL(s.page.url());
  if (!['https:', 'http:'].includes(pageUrl.protocol)) throw new Error('fill requires an HTTP(S) origin');
  const literal = assertNonCredentialInput(value, target);
  return s.runStep(`fill_${target}`, () => fillPage(s, target, literal, pageUrl.origin));
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
  // Final merged dump — fires the close-time flush of every frame's
  // property-trap log + writes the same {accesses, requests, console,
  // pageerrors, persona, proxy, versions} shape the interval writer uses,
  // overwriting the in-flight file with the freshest state. Output lives at
  // recordings/<label>/<label>_<iso>.inst.json so uploadArtifacts picks it up.
  try {
    const { finalDump } = await import('./net_record.js');
    await finalDump(s);
  } catch (e: any) { console.log(`[wsession] finalDump err: ${e?.message?.slice(0, 120)}`); }
  // G18: capture a fingerprint + detection-vector report at close so failed
  // runs carry an automatic diagnosis of why they may have been flagged.
  await wsCaptureFingerprint(s);
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
  // G8: persist the per-run captcha event log (challenge_faced + the full
  // attempt/marker sequence) for storage backup + worker import. Always written
  // so a no-captcha run is recorded as {challenge_faced:false, events:[]},
  // distinguishable from a missing file.
  if (s.label) {
    try {
      const { captchaSnapshot } = await import('../../captcha/events.js');
      writeFileSync(join(recordingsDir(s.label), 'captcha_events.json'), JSON.stringify(captchaSnapshot(), null, 2));
    } catch (e: any) { console.log(`[wsession] captcha_events write err: ${e?.message?.slice(0, 120)}`); }
  }
  await costTracker.flush().catch(() => {});
  console.log(`[wsession] close() done`);
}
