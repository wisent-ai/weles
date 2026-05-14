// Capture TikTok's mssdk JS files — these generate msToken, X-Bogus, X-Gnarly
// via browser fingerprint reads that flag our session as bot-like.

import { WSession } from '../../../dist/session/wsession.js';
import { generatePersona } from '../../../dist/browser/persona.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const persona = generatePersona({ country: 'US', os: 'windows' });
const s = await WSession.start({ label: 'probe_mssdk', proxy: process.env.PROBE_PROXY || 'residential', persona });

const saveDir = 'recordings/probe_mssdk';
mkdirSync(saveDir, { recursive: true });

const captured = new Map();

s.page.on('response', async (resp) => {
  const u = resp.url();
  const ct = (resp.headers()['content-type'] || '').toLowerCase();
  const isJs = /\.js(\?|$)|application\/javascript|text\/javascript/.test(u + ' ' + ct);
  // Capture ALL TikTok JS (signup page bundles + mssdk + ticket-guard)
  const interesting = isJs && /tiktok|ttwstatic|byteoversea/.test(u);
  if (!interesting) return;
  try {
    const text = await resp.text();
    captured.set(u, { status: resp.status(), body: text, headers: resp.headers() });
    console.log(`[js] ${resp.status()} ${u.slice(u.lastIndexOf('/') + 1, u.length).slice(0, 80)}  len=${text.length}`);
  } catch (e) {
    console.log(`[js-err] ${u.slice(0, 120)}: ${e.message?.slice(0, 80)}`);
  }
});

s.page.on('request', (req) => {
  const u = req.url();
  if (/mssdk|web\/ping|web\/report|web\/common|X-Bogus|msToken/.test(u)) {
    const body = (() => { try { return req.postData()?.slice(0, 300) || ''; } catch { return ''; } })();
    console.log(`[mssdk-req] ${req.method()} ${u.slice(0, 180)}${body ? '  body=' + body : ''}`);
  }
});
s.page.on('response', async (resp) => {
  const u = resp.url();
  if (/mssdk.*\/(web\/ping|web\/report|web\/common|ztca)/.test(u)) {
    let body = '';
    try { body = (await resp.text()).slice(0, 300); } catch {}
    console.log(`[mssdk-res] ${resp.status()} ${u.slice(0, 160)}  body=${body.replace(/\s+/g, ' ')}`);
  }
});

try {
  await s.goto('https://www.tiktok.com/signup/phone-or-email/email');
  await s.wait(8);
  await s.wait(5);

  console.log(`\n=== CAPTURED ${captured.size} mssdk-like JS files ===`);
  for (const [url, { body }] of captured) {
    const safe = url.split('/').pop().split('?')[0].slice(0, 80).replace(/[^a-zA-Z0-9._-]/g, '_');
    const fname = `${saveDir}/${safe}`;
    writeFileSync(fname, body);
    console.log(`  saved ${fname}  (${body.length} bytes)`);
  }

  const globals = await s.page.evaluate(`(() => {
    const out = {};
    const keys = Object.keys(window).filter(k => /webmssdk|tt-ticket|SIGI|_msToken|_xBogus|_xGnarly|byted|bdygvsdk/i.test(k));
    for (const k of keys) {
      try { out[k] = typeof window[k] === 'function' ? 'function' : JSON.stringify(window[k]).slice(0, 200); } catch (e) { out[k] = 'err: ' + e.message.slice(0, 60); }
    }
    return out;
  })()`).catch(e => ({ error: e.message }));
  console.log(`\n=== window globals (mssdk-related) ===`);
  console.log(JSON.stringify(globals, null, 2));

} catch (e) {
  console.error('ERR:', e.message?.slice(0, 300));
} finally {
  await s.close().catch(() => {});
}
