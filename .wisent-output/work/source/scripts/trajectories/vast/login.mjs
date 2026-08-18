import { WSession } from '../../../dist/session/wsession.js';
import { SessionStore } from '../../../dist/session/store.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { readScopedLogin } from '../../_shared/scoped-secrets.mjs';

const LABEL = 'vast';
const VAST_LOGIN = readScopedLogin('vastDashboard');
const EMAIL = VAST_LOGIN.email;
const PWD = VAST_LOGIN.password;
const PRICE_GPU = process.env.PRICE_GPU ?? '0.80';

const ws = await WSession.start({ label: LABEL, headless: false });
const store = new SessionStore();
// Grant clipboard read/write so the Copy button round-trips through JS.
await ws.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://cloud.vast.ai' }).catch(() => {});

async function loggedIn() {
  return ws.page.evaluate(`(() => {
    var h = (document.querySelector('header')?.innerText || '').toLowerCase();
    if (/\\blog\\s*in\\b|\\bsign\\s*in\\b/.test(h)) return false;
    var all = (document.body?.innerText || '').toLowerCase();
    return /wisent/.test(all) || /credit:/.test(h);
  })()`).catch(() => false);
}

try {
  await ws.goto('https://cloud.vast.ai/');
  await humanIdlePause('deliberate');

  if (!(await loggedIn())) {
    console.log('[vast] not logged in; running OAuth');
    await ws.click('Login');
    await humanIdlePause('deliberate');
    const popupP = ws.ctx.waitForEvent('page').catch(() => null);
    await ws.click('Continue with Google');
    const popup = await popupP;
    console.log('[vast] popup opened:', !!popup);
    if (popup) {
      try { await popup.waitForLoadState('domcontentloaded'); } catch {}
      for (let i = 0; i < 60; i++) {
        if (popup.isClosed?.()) break;
        let path = '';
        try { path = new URL(popup.url()).pathname; } catch {}
        if (path.includes('/signin/identifier')) {
          try { await popup.fill('input[type="email"]', EMAIL); await popup.click('#identifierNext').catch(() => {}); } catch {}
        } else if (path.includes('/challenge/pwd') || path.includes('/challenge/password')) {
          if (!PWD) { console.log('FAIL: no password'); break; }
          try { await popup.fill('input[type="password"]', PWD); await popup.click('#passwordNext').catch(() => {}); } catch {}
        } else if (path.includes('/signin/oauth/') || path.includes('/oauthconsent')) {
          await popup.evaluate(`(() => { var b = Array.from(document.querySelectorAll('button,[role="button"],a')).find(e => /^(continue|allow|confirm)$/i.test((e.innerText||'').trim())); if (b) b.click(); })()`).catch(() => {});
        }
        await humanIdlePause('short');
      }
    }
    await humanIdlePause('deliberate');
    const saved = await store.capturePlaywright(ws.ctx, LABEL);
    console.log(`[vast] login flow captured ${saved.length} cookies`);
  } else {
    console.log('[vast] session restored from SessionStore');
  }

  await ws.page.evaluate(`(async () => {
    var r = await fetch('/api/v0/auth/apikeys/', { credentials: 'include' });
    var keys = (await r.json()).apikeys || [];
    var team = keys.find(k => k.key_type === 'team' && k.team_name === 'Wisent');
    if (team) {
      await fetch('/api/v0/users/save-context/', {
        method: 'PUT', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context_key_id: team.id }),
      });
    }
  })()`);

  await ws.goto('https://cloud.vast.ai/host/machines/');
  await humanIdlePause('long');
  await store.capturePlaywright(ws.ctx, LABEL);

  await ws.page.goto('https://cloud.vast.ai/host/setup/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');

  // Find the <pre>/<code> block containing the real install command, scroll
  // to it, then click the Copy button that sits nearest to it. Capture the
  // FULL text of that block and the clipboard contents.
  const result = await ws.page.evaluate(`(async () => {
    function tidy(t) { return (t || '').replace(/\\s+/g, ' ').trim(); }
    // Find all code-like blocks whose text matches the install pattern.
    var blocks = Array.from(document.querySelectorAll('code, pre, [class*="ode"], input, textarea'))
      .filter(el => el.offsetParent !== null)
      .filter(el => {
        var t = el.innerText || el.value || el.textContent || '';
        return /wget/i.test(t) && /install/i.test(t) && /python3/i.test(t);
      });
    if (blocks.length === 0) return { ok: false, reason: 'no install block' };
    // Prefer the block with the longest text (the real personalized command
    // should be longer than any docs example blurb).
    blocks.sort((a, b) => (b.innerText || b.textContent || '').length - (a.innerText || a.textContent || '').length);
    var target = blocks[0];
    target.scrollIntoView({ block: 'center' });
    var raw = (target.innerText || target.value || target.textContent || '').trim();
    // Look for a Copy button within ~400px of the block.
    var rect = target.getBoundingClientRect();
    var allBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(b => b.offsetParent !== null);
    var copyBtn = allBtns
      .filter(b => /^copy\\b/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()))
      .map(b => ({ b, r: b.getBoundingClientRect() }))
      .map(x => ({ b: x.b, d: Math.hypot((x.r.left + x.r.right)/2 - (rect.left + rect.right)/2, (x.r.top + x.r.bottom)/2 - (rect.top + rect.bottom)/2) }))
      .sort((a, b) => a.d - b.d)[0];
    // Don't click the copy button — raw text is already extracted via
    // .innerText. Clicking via evaluate fires isTrusted=false (lint flagged
    // this); clipboard.readText below is best-effort and not load-bearing.
    var clip = '';
    try { clip = await navigator.clipboard.readText(); } catch (e) { clip = 'ERR ' + e.message; }
    return { ok: true, raw, raw_len: raw.length, btn_label: copyBtn ? tidy(copyBtn.b.innerText || copyBtn.b.getAttribute('aria-label') || '') : null, btn_dist: copyBtn ? copyBtn.d : null, clipboard: clip };
  })()`);
  console.log('[vast] install block result ->', JSON.stringify(result).slice(0, 2000));

  await ws.page.screenshot({ path: '/tmp/vast_install_cmd.png', fullPage: true }).catch(() => {});
  console.log('[vast] final screenshot -> /tmp/vast_install_cmd.png');
  await ws.page.screenshot({ path: '/tmp/vast_transcript.png', fullPage: true }).catch(() => {});
  console.log('[vast] screenshot -> /tmp/vast_transcript.png');
  await humanIdlePause('long');

  const afterState = await ws.page.evaluate(`(() => {
    var t = ((document.body?.innerText || '').match(/[^\\n]*(listed|success|error|fail|invalid|unauth)[^\\n]*/i) || [null])[0];
    return { toast: t ? t.slice(0, 200) : null, url: location.href };
  })()`);
  console.log('[vast] after state ->', JSON.stringify(afterState));

  await ws.page.screenshot({ path: '/tmp/vast_weles_final.png', fullPage: true }).catch(() => {});
  console.log('[vast] screenshot -> /tmp/vast_weles_final.png');

  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 400)}`);
  await ws.page.screenshot({ path: '/tmp/vast_weles_err.png', fullPage: true }).catch(() => {});
  process.exit(1);
} finally {
  await ws.ctx.close?.().catch(() => {});
}
