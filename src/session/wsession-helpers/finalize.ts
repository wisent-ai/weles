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
import { writeFileSync, mkdirSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { costTracker } from '../../utils/cost.js';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../diagnostics/fingerprint_probe.js';
import { analyze, pickBaseline } from '../../diagnostics/fingerprint_analyzer.js';
import { markSignupSuccess } from '../../utils/email/domain.js';
import { assertNonCredentialInput, withCapability } from '../../utils/capability.js';
import type { CapabilityRef } from '../../utils/capability.js';
import { getEmailApiKey } from '../../utils/credentials.js';
import { humanClick, humanClickLocator } from '../../human/mouse.js';
import { humanFill, humanType } from '../../human/keyboard.js';
import { findClickTarget, type ScreenshottablePage } from '../../vision/analyze.js';
import type { WSession } from '../wsession.js';
import { runRecordingsDir, runRecordingsRoot } from '../run-recordings.js';
import { optionalWelesDatabase } from '../../utils/weles-database.js';

const VISIBILITY_PROBE_MS = 1500;

const asV = (p: any) => p as unknown as ScreenshottablePage;

function childFrames(s: WSession, allowedOrigin?: string): Frame[] {
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

async function firstVisible(loc: any): Promise<any | null> {
  try {
    const first = loc?.first?.() ?? loc;
    let count = 1;
    if (typeof loc?.count === 'function') count = await loc.count().catch(() => 0);
    if (count > 0 && await first.isVisible({ timeout: VISIBILITY_PROBE_MS }).catch(() => false)) return first;
  } catch {}
  return null;
}


// G17: per-run layout — recordings/<run_uuid>/<label>/.
function recordingsDir(label?: string): string {
  return label ? runRecordingsDir(label) : runRecordingsRoot();
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

async function fillPage(s: WSession, target: string, value: string, allowedOrigin?: string): Promise<string> {
  const v = value;
  const kws = target.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const sels = kws.flatMap(k => ['input','textarea','[contenteditable]'].flatMap(t => [`${t}[name*="${k}"]`,`${t}[placeholder*="${k}" i]`,`${t}[aria-label*="${k}" i]`]));
  for (const frame of childFrames(s, allowedOrigin)) {
    try { const lbl = await firstVisible(frame.getByLabel?.(target, { exact: false })); if (lbl) { await humanFill(s.page, lbl, v); return 'filled frame label'; } } catch {}
    const emailHint = /\b(email|e-mail)\b/i.test(target);
    if (emailHint) {
      const emailInput = await firstVisible(frame.locator?.('input[type="email"], input[name*="email" i], input[autocomplete*="email" i]'));
      if (emailInput) { await humanFill(s.page, emailInput, v); return 'filled frame email'; }
    }
    for (const sel of sels) {
      try { const el = await firstVisible(frame.locator?.(sel)); if (el) { await humanFill(s.page, el, v); return `filled frame ${sel}`; } } catch {}
    }
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

export async function wsFillCredential(
  s: WSession,
  target: string,
  fieldClass: 'password' | 'email' | 'username' | 'token' | 'api-key',
  capability: CapabilityRef,
): Promise<string> {
  const pageUrl = new URL(s.page.url());
  const origin = pageUrl.origin;
  if (!['https:', 'http:'].includes(pageUrl.protocol)) throw new Error('credential fill requires an HTTP(S) origin');
  const targetText = target.toLowerCase();
  const expectedHints: Record<typeof fieldClass, RegExp> = {
    password: /password|passcode|secret/,
    email: /email|e-mail/,
    username: /username|user name|login/,
    token: /token|verification code|one-time code|otp/,
    'api-key': /api.?key|access key/,
  };
  if (!expectedHints[fieldClass].test(targetText)) throw new Error('credential field class mismatch');
  const expected = { purpose: 'weles.browser.fill' as const, resource: `origin:${origin}/${fieldClass}` };
  return withCapability(capability, expected, async (secret) => {
    try {
      const result = await fillPage(s, target, secret, origin);
      return result.startsWith('filled') ? `credential ${result}` : result;
    } catch {
      throw new Error('credential fill failed');
    }
  });
}

export async function wsCheckEmail(s: WSession, email: string, sender: string): Promise<string> {
  const key = await getEmailApiKey() ?? '';
  if (!key) return 'error: no RESEND_RECEIVING_API_KEY';
  const addr = s.resolveEnv(email).toLowerCase();
  const earliestAcceptMs = Date.now() - 90_000;
  for (let attempt = 0; attempt < 18; attempt++) {
    const r = await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${key}` } });
    for (const em of ((await r.json()) as any).data ?? []) {
      const to = (em.to ?? []).map((t: any) => (typeof t === 'string' ? t : t.email ?? '').toLowerCase());
      if (!to.includes(addr)) continue;
      if (sender && !(em.from ?? '').toLowerCase().includes(sender)) continue;
      const emAt = em.created_at ? new Date(em.created_at).getTime() : 0;
      if (emAt < earliestAcceptMs) continue;
      const d = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${key}` } })).json() as any;
      const content = `${d.subject ?? ''}\n${d.text ?? ''}\n${d.html ?? ''}`;
      const codes = content.match(/\b\d{5,6}\b/g);
      if (codes) return codes[0];
      return `email received without numeric code: ${content.replace(/\s+/g, ' ').trim().slice(0, 2000)}`;
    }
    await new Promise(r => setTimeout(r, 10000));  // allow-raw-playwright: bounded polling/rate-limit loop
  }
  return 'no matching email received within timeout';
}

export async function wsSaveAccount(
  s: WSession,
  platform: string,
  data: { username: string; email: string; password: string; name?: string; status?: string },
): Promise<string> {
  const url = optionalWelesDatabase()?.url ?? '';
  const key = optionalWelesDatabase()?.token ?? '';
  if (!url || !key) return 'error: missing weles-database launcher configuration';
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

async function wsCaptureFingerprint(s: WSession): Promise<void> {
  if (!s.label) return;
  if (process.env.WELES_FINGERPRINT === '0') return;
  try {
    const js = await s.page.evaluate(FP_SCRIPT);
    let network: any = null;
    try {
      await s.page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded' });
      const raw = await s.page.evaluate(`document.body.innerText || document.body.textContent || ''`);
      network = parseNetworkFingerprint(raw);
    } catch (e: any) {
      network = { _err: String(e?.message ?? e).slice(0, 200) };
    }
    const payload = {
      capturedAt: new Date().toISOString(),
      source: 'weles-auto',
      browser: (s as any)._browserProvenance?.browser ?? 'unknown',
      js,
      network,
    };
    const fpPath = join(recordingsDir(s.label), 'fingerprint.json');
    writeFileSync(fpPath, JSON.stringify(payload, null, 2));
    console.log(`[wsession] fingerprint saved ${fpPath}`);

    const baselineDir = process.env.WELES_BASELINE_DIR || join(process.cwd(), 'recordings', 'baselines');
    if (existsSync(baselineDir)) {
      const { path: baselinePath, data: baseline } = pickBaseline(baselineDir, payload);
      let report = analyze(payload, baseline);
      report.meta.subjectPath = fpPath;
      report.meta.baselinePath = baselinePath;

      // Detect network fingerprint drift between early (pre-action) and final
      // (close-time) captures. If the only change is the appearance of the TLS
      // 1.3 pre_shared_key extension after the target site was visited, the
      // drift is expected session resumption — not a detection signal. The
      // target saw the early JA4; the close-time JA4 is a measurement artifact.
      const earlyPath = join(recordingsDir(s.label), 'early_fingerprint.json');
      let pskDrift = false;
      const driftFields: string[] = [];
      if (existsSync(earlyPath)) {
        try {
          const early = JSON.parse(readFileSync(earlyPath, 'utf-8'));
          const earlyExts = new Set((early?.network?.extensions || []) as string[]);
          const finalExts = new Set((network?.extensions || []) as string[]);
          const isGrease = (x: string) => x.startsWith('TLS_GREASE');
          const added = [...finalExts].filter((x) => !earlyExts.has(x) && !isGrease(x));
          const removed = [...earlyExts].filter((x) => !finalExts.has(x) && !isGrease(x));
          pskDrift = added.length === 1 && added[0] === 'pre_shared_key (41)' && removed.length === 0;
          for (const f of ['ja4', 'peetprint_hash', 'akamaiH2'] as const) {
            const e = early?.network?.[f] ?? null;
            const fin = network?.[f] ?? null;
            if (e && fin && e !== fin) driftFields.push(f);
          }
          if (driftFields.length) {
            const drift: Record<string, { early: string | null; final: string | null; pskExpected?: boolean }> = {};
            for (const f of driftFields) {
              drift[f] = { early: early?.network?.[f] ?? null, final: network?.[f] ?? null, pskExpected: pskDrift };
            }
            const driftPath = join(recordingsDir(s.label), 'network_drift.json');
            writeFileSync(driftPath, JSON.stringify({ capturedAt: new Date().toISOString(), pskDrift, drift }, null, 2));
            console.log(`[wsession] network drift detected: ${driftFields.join(', ')}${pskDrift ? ' (expected PSK resumption)' : ''} — saved ${driftPath}`);
          }
        } catch (e: any) {
          console.log(`[wsession] network drift compare error: ${e?.message?.slice(0, 200)}`);
        }
      }

      if (pskDrift) {
        const pskFindingIds = new Set(['tls_ja4_mismatch', 'tls_peetprint_mismatch']);
        const before = report.summary.riskScore;
        report.findings = report.findings.filter((f) => !pskFindingIds.has(f.id));
        // Recompute summary.
        const counts = { critical: 0, warning: 0, info: 0 };
        const byCategory: Record<string, number> = {};
        const SEVERITY_WEIGHT: Record<string, number> = { critical: 10, warning: 5, info: 2 };
        let riskScore = 0;
        for (const f of report.findings) {
          counts[f.severity]++;
          riskScore += SEVERITY_WEIGHT[f.severity];
          byCategory[f.category] = (byCategory[f.category] || 0) + 1;
        }
        report.summary = { totalFindings: report.findings.length, ...counts, riskScore, byCategory };
        report.meta.pskDriftExplained = true;
        console.log(`[wsession] PSK drift explained: removed TLS mismatch findings, risk ${before} -> ${report.summary.riskScore}`);
      }

      const reportPath = join(recordingsDir(s.label), 'detection_report.json');
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`[wsession] detection report saved ${reportPath} risk=${report.summary.riskScore} critical=${report.summary.critical}`);
    }
  } catch (e: any) {
    console.log(`[wsession] fingerprint capture error: ${e?.message?.slice(0, 200)}`);
  }
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
