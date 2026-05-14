// Instrument TikTok's JS to see exactly what happens on "Send code" click.
//
// We install probes BEFORE TikTok's JS runs (via addInitScript) that wrap:
//   - window.fetch
//   - XMLHttpRequest.open/send
//   - navigator.sendBeacon
//   - Uncaught errors (error + unhandledrejection)
//   - console.error / console.warn
//   - EventTarget.addEventListener (for 'click' on send-code-button)
//
// Each call is pushed into window.__wtrace which we read back after the click.
// Goal: find out whether TikTok's JS even *attempts* /send_code/ or aborts earlier,
// and if it errors — what the exception is.

import { WSession } from '../../../dist/session/wsession.js';
import { generatePersona } from '../../../dist/browser/persona.js';

const INIT = `
(() => {
  window.__wtrace = [];

  const push = (evt) => { try { window.__wtrace.push({ t: Date.now(), ...evt }); } catch(_){} };

  const origFetch = window.fetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    const opts = args[1] || {};
    const stack = new Error().stack?.split('\\n').slice(1, 10).join(' | ');
    push({ type: 'fetch', url, method: opts.method || 'GET', body: typeof opts.body === 'string' ? opts.body.slice(0, 400) : '', stack });
    return origFetch.apply(this, args).then(r => {
      push({ type: 'fetch-resp', url, status: r.status });
      return r;
    }, e => { push({ type: 'fetch-err', url, err: String(e).slice(0, 300) }); throw e; });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__wmethod = method; this.__wurl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const stack = new Error().stack?.split('\\n').slice(1, 10).join(' | ');
    push({ type: 'xhr', url: this.__wurl, method: this.__wmethod, body: typeof body === 'string' ? body.slice(0, 400) : '', stack });
    this.addEventListener('load', () => push({ type: 'xhr-resp', url: this.__wurl, status: this.status }));
    this.addEventListener('error', () => push({ type: 'xhr-err', url: this.__wurl }));
    return origSend.call(this, body);
  };

  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      push({ type: 'beacon', url, body: typeof data === 'string' ? data.slice(0, 300) : '[blob]' });
      return origBeacon(url, data);
    };
  }

  window.addEventListener('error', (e) => push({ type: 'error', msg: String(e.message).slice(0, 300), stack: String(e.error?.stack || '').slice(0, 600) }), true);
  window.addEventListener('unhandledrejection', (e) => push({ type: 'unhandledrejection', reason: String(e.reason?.message || e.reason).slice(0, 300), stack: String(e.reason?.stack || '').slice(0, 600) }), true);

  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args) => { push({ type: 'console.error', msg: args.map(a => typeof a === 'string' ? a.slice(0, 200) : (a?.message || (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' | ').slice(0, 600) }); return origErr(...args); };
  console.warn = (...args) => { push({ type: 'console.warn', msg: args.map(a => typeof a === 'string' ? a.slice(0, 200) : (a?.message || (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' | ').slice(0, 600) }); return origWarn(...args); };

  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, opts) {
    if (type === 'click' && this instanceof Element) {
      const de = this.getAttribute?.('data-e2e');
      if (/send-code/.test(de || '')) {
        push({ type: 'click-handler-attached', dataE2e: de, listenerSrc: String(listener).slice(0, 300) });
      }
    }
    return origAdd.call(this, type, listener, opts);
  };

  // Wrap crypto.subtle methods — Ticket Guard uses ECDSA sign/verify, generateKey, importKey
  if (globalThis.crypto && crypto.subtle) {
    const subtle = crypto.subtle;
    const wrapMethod = (name) => {
      const orig = subtle[name]?.bind(subtle);
      if (!orig) return;
      subtle[name] = async function(...args) {
        const stack = new Error().stack?.split('\\n').slice(1, 8).join(' | ');
        const argSum = (() => {
          try {
            return args.map(a => {
              if (a && a.name) return { name: a.name, namedCurve: a.namedCurve, hash: a.hash, modulusLength: a.modulusLength };
              if (a instanceof ArrayBuffer) return { _buf: 'ArrayBuffer', len: a.byteLength };
              if (ArrayBuffer.isView(a)) return { _buf: a.constructor.name, len: a.byteLength };
              if (typeof a === 'string') return { _str: a.slice(0, 80) };
              if (a && typeof a === 'object' && a.type) return { cryptoKey: { type: a.type, alg: a.algorithm, usages: a.usages, extractable: a.extractable } };
              return String(a).slice(0, 100);
            });
          } catch (e) { return '[arg-serialize-err]'; }
        })();
        const entry = { type: 'subtle.' + name, args: argSum, stack };
        try {
          const r = await orig(...args);
          entry.ok = true;
          if (r instanceof ArrayBuffer) entry.resultLen = r.byteLength;
          else if (r && r.type) entry.resultKey = { type: r.type, alg: r.algorithm, usages: r.usages };
          else if (r && r.publicKey) entry.resultKeyPair = { pub: { type: r.publicKey.type, alg: r.publicKey.algorithm }, priv: { type: r.privateKey.type, alg: r.privateKey.algorithm } };
          push(entry);
          return r;
        } catch (e) {
          entry.ok = false;
          entry.err = String(e).slice(0, 300);
          push(entry);
          throw e;
        }
      };
    };
    'sign verify generateKey importKey exportKey deriveKey deriveBits encrypt decrypt digest wrapKey unwrapKey'.split(' ').forEach(wrapMethod);
  }

  // Also capture localStorage / sessionStorage access — TG SDK stores certs/keys there
  const wrapStorage = (s, name) => {
    if (!s) return;
    const origGet = s.getItem.bind(s);
    const origSet = s.setItem.bind(s);
    s.getItem = (k) => { const v = origGet(k); if (/sdk_cert|sdk_crypt|ticket|zti|passport/i.test(k)) push({ type: 'storage.getItem', storage: name, key: k, valueLen: v?.length || 0, valuePrefix: (v || '').slice(0, 100) }); return v; };
    s.setItem = (k, v) => { if (/sdk_cert|sdk_crypt|ticket|zti|passport/i.test(k)) push({ type: 'storage.setItem', storage: name, key: k, valueLen: v?.length || 0, valuePrefix: String(v).slice(0, 100) }); return origSet(k, v); };
  };
  wrapStorage(localStorage, 'local');
  wrapStorage(sessionStorage, 'session');
})();
`;

const browser = process.env.PROBE_BROWSER;
const persona = generatePersona({ country: 'US', browser });
const s = await WSession.start({ label: 'probe_send_code', proxy: process.env.PROBE_PROXY || 'residential', persona });

await s.ctx.addInitScript({ content: INIT });

try {
  const id = await s.generateIdentity('tiktok');
  const password = `Wisent${Math.floor(Math.random() * 100000)}!Xy`;
  console.log(`[probe] identity: ${id.email}`);

  s.page.on('request', (req) => {
    const u = req.url();
    if (/send_code|check_code|passport\/web\/region|verification\/age|captcha/.test(u)) {
      console.log(`[pw-req] ${req.method()} ${u.slice(0, 140)}`);
    }
  });
  s.page.on('response', async (resp) => {
    const u = resp.url();
    const isRegion = /passport\/web\/region|passport\/web\/store_region/.test(u) && resp.request().method() === 'POST';
    if (!isRegion && !/send_code|check_code|verification\/age|captcha/.test(u)) return;
    let body = ''; try { body = (await resp.text()); } catch {}
    const h = resp.headers();
    const tag = isRegion ? 'pw-res-region' : 'pw-res';
    console.log(`[${tag}] ${resp.status()} ct=${h['content-type'] || '-'} len=${body.length} origin-crypt=${h['tt-ticket-guard-origin-crypt'] ? 'YES' : 'NO'} logid=${h['x-tt-logid'] || '-'}`);
    console.log(`  body: ${body.slice(0, 500).replace(/\s+/g, ' ')}`);
  });

  // Navigate directly to email signup — skip phone page entirely
  await s.goto('https://www.tiktok.com/signup/phone-or-email/email');
  await s.wait(4);

  for (const sel of ['button:has-text("Decline optional cookies")', 'button:has-text("Accept all")']) {
    try { const b = s.page.locator(sel).first(); if (await b.isVisible().catch(() => false)) { await b.click(); await s.wait(1); break; } } catch {}
  }

  // If we landed somewhere else (e.g. /phone or home), try clicking through
  if (!(s.page.url?.() ?? '').includes('/email')) {
    for (let i = 0; i < 4; i++) {
      if ((s.page.url?.() ?? '').includes('/phone-or-email')) break;
      await s.click('Use phone or email'); await s.wait(2);
    }
    for (const linkText of ['Sign up with email', 'Sign up with email instead', 'Email']) {
      if ((s.page.url?.() ?? '').includes('/email')) break;
      try { await s.click(linkText); await s.wait(2); } catch {}
    }
  }
  console.log(`[probe] URL after nav: ${s.page.url?.() ?? ''}`);

  await s.select('month', id.birthMonth);
  await s.select('day', id.birthDay);
  await s.select('year', id.birthYear);
  await s.wait(1);
  await s.fill('Email', id.email);
  await s.fill('Password', password);
  await s.page.keyboard.press('Tab').catch(() => {});
  await s.wait(2);

  const before = await s.page.evaluate(`JSON.stringify((window.__wtrace || []).length)`);
  console.log(`[probe] trace entries before Send code click: ${before}`);

  const handlers = await s.page.evaluate(`JSON.stringify((window.__wtrace || []).filter(e => e.type === 'click-handler-attached'))`);
  console.log(`[probe] click handlers bound to send-code-button:\n${handlers}`);

  const btnInfo = await s.page.evaluate(`(() => {
    const btn = document.querySelector('[data-e2e="send-code-button"]');
    if (!btn) return { present: false };
    const fKey = Object.keys(btn).find(k => k.startsWith('__reactProps'));
    const props = fKey ? btn[fKey] : null;
    return {
      present: true,
      disabled: btn.disabled,
      ariaDisabled: btn.getAttribute('aria-disabled'),
      hasOnClick: !!(props && props.onClick),
      propKeys: props ? Object.keys(props) : [],
      onClickSrc: props?.onClick ? String(props.onClick).slice(0, 800) : null,
    };
  })()`);
  console.log(`[probe] Send code btn: ${JSON.stringify(btnInfo)}`);

  // Pre-attach a Playwright response waiter for /send_code/ so we capture its body.
  const sendCodePromise = s.page.waitForResponse(resp => /\/passport\/web\/email\/send_code\//.test(resp.url())).catch(e => ({ _err: e.message }));

  console.log(`[probe] clicking Send code...`);
  const clickResult = await s.click('Send code');
  console.log(`[probe] s.click('Send code') => ${clickResult}`);

  // Wait for /send_code/ response — the real answer
  const sendCodeResp = await Promise.race([
    sendCodePromise,
    new Promise(r => setTimeout(() => r({ _err: 'timeout 20s' }), 20000)),  // allow-raw-playwright: Promise.race deadline
  ]);
  if (sendCodeResp && sendCodeResp._err) {
    console.log(`[probe] /send_code/ response TIMEOUT: ${sendCodeResp._err}`);
  } else if (sendCodeResp) {
    let body = '';
    try { body = await sendCodeResp.text(); } catch (e) { body = `[text() err: ${e.message}]`; }
    const hdrs = sendCodeResp.headers();
    console.log(`\n=== /send_code/ RESPONSE ===`);
    console.log(`  status: ${sendCodeResp.status()}`);
    console.log(`  url: ${sendCodeResp.url().slice(0, 200)}`);
    console.log(`  headers: ${JSON.stringify(hdrs).slice(0, 800)}`);
    console.log(`  body-length: ${body.length}`);
    console.log(`  body: ${body.slice(0, 1000)}`);
  }

  await s.wait(8);

  const trace = await s.page.evaluate(`JSON.stringify(window.__wtrace || [])`);
  const parsed = JSON.parse(trace);
  console.log(`\n=== TRACE: ${parsed.length} total events ===`);

  const beforeN = parseInt(before);
  const afterClick = parsed.slice(beforeN);
  console.log(`=== ${afterClick.length} events AFTER Send code click ===\n`);
  for (const e of afterClick.slice(0, 80)) {
    if (e.type === 'fetch' || e.type === 'xhr' || e.type === 'beacon') {
      console.log(`  [${e.type}] ${e.method || ''} ${(e.url || '').slice(0, 140)}${e.body ? '\n    body: ' + e.body : ''}${e.stack ? '\n    stack: ' + e.stack.slice(0, 500) : ''}`);
    } else if (e.type === 'fetch-resp' || e.type === 'xhr-resp') {
      console.log(`  [${e.type}] ${e.status} ${(e.url || '').slice(0, 140)}`);
    } else if (e.type === 'error' || e.type === 'unhandledrejection') {
      console.log(`  [${e.type}] ${e.msg || e.reason}\n    stack: ${(e.stack || '').slice(0, 600)}`);
    } else if (e.type === 'console.error' || e.type === 'console.warn') {
      console.log(`  [${e.type}] ${e.msg}`);
    } else if (e.type === 'fetch-err' || e.type === 'xhr-err') {
      console.log(`  [${e.type}] ${(e.url || '').slice(0, 140)} ${e.err || ''}`);
    }
  }

  const apiEvents = afterClick.filter(e =>
    (e.type === 'fetch' || e.type === 'xhr' || e.type === 'beacon' || e.type === 'fetch-resp' || e.type === 'xhr-resp' || e.type === 'fetch-err' || e.type === 'xhr-err')
    && /passport|send_code|verification|register|check_code|captcha|region/.test(e.url || '')
  );
  console.log(`\n=== ${apiEvents.length} TikTok-API events after click ===`);
  for (const e of apiEvents) console.log(`  [${e.type}] ${e.method || e.status || ''} ${(e.url || '').slice(0, 160)}`);

  const sendCodeCalls = afterClick.filter(e => (e.url || '').includes('/send_code'));
  console.log(`\n=== /send_code/ calls: ${sendCodeCalls.length} ===`);

  const errors = afterClick.filter(e => e.type === 'error' || e.type === 'unhandledrejection' || e.type === 'console.error');
  console.log(`=== ${errors.length} error/rejection/console.error events ===`);
  const cryptoAll = parsed.filter(e => (e.type || '').startsWith('subtle.'));
  const cryptoFail = cryptoAll.filter(e => e.ok === false);
  const cryptoSigns = cryptoAll.filter(e => e.type === 'subtle.sign');
  const cryptoVerifies = cryptoAll.filter(e => e.type === 'subtle.verify');
  console.log(`\n=== crypto.subtle: total=${cryptoAll.length}  failed=${cryptoFail.length}  signs=${cryptoSigns.length}  verifies=${cryptoVerifies.length} ===`);
  for (const e of cryptoFail.slice(0, 10)) console.log(`  FAIL [${e.type}] err=${e.err}  args=${JSON.stringify(e.args).slice(0, 200)}`);
  for (const e of cryptoSigns.slice(0, 8)) console.log(`  sign ok=${e.ok} args=${JSON.stringify(e.args).slice(0, 180)} resultLen=${e.resultLen || '-'} err=${e.err || ''}`);
  for (const e of cryptoVerifies.slice(0, 5)) console.log(`  verify ok=${e.ok} args=${JSON.stringify(e.args).slice(0, 180)} err=${e.err || ''}`);
  const storage = parsed.filter(e => (e.type || '').startsWith('storage.'));
  console.log(`\n=== TG storage ops: ${storage.length} ===`);
  for (const e of storage.slice(0, 8)) console.log(`  [${e.type}] ${e.storage} key=${e.key} len=${e.valueLen} prefix=${e.valuePrefix?.slice(0, 60) || ''}`);

  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('recordings/probe_send_code', { recursive: true });
  const fname = `recordings/probe_send_code/trace_${Date.now()}.json`;
  writeFileSync(fname, JSON.stringify({ beforeClickIdx: beforeN, afterClickCount: afterClick.length, all: parsed }, null, 2));
  console.log(`\nSaved full trace to ${fname}`);
} catch (e) {
  console.error('ERR:', e.message?.slice(0, 300));
} finally {
  await s.close().catch(() => {});
}
