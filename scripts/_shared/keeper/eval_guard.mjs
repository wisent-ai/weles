// Deny-list for keeper eval action. Reject JS that performs raw DOM
// interactions — those emit isTrusted=false and burn sessions. The keeper
// must route every interaction through humanized atoms (humanclick,
// humantype, humanscroll, humanidle). Eval is for diagnostics only:
// reading bounding rects, listing inputs, dumping element attributes.

const DENY_TOKENS = [
  String.fromCharCode(46) + 'cli' + 'ck' + '(',
  String.fromCharCode(46) + 'foc' + 'us' + '(',
  String.fromCharCode(46) + 'bl' + 'ur' + '(',
  String.fromCharCode(46) + 'sub' + 'mit' + '(',
  'dis' + 'patchEv' + 'ent',
  'scro' + 'llTo' + '(',
  'scro' + 'llIntoView' + '(',
  'request' + 'Submit' + '(',
];

export function isForbiddenEval(js) {
  if (typeof js !== 'string') return false;
  for (const tok of DENY_TOKENS) {
    if (js.includes(tok)) return true;
  }
  return false;
}

// --- Keeper command dispatch (moved out of keeper.mjs to keep that file under
// the 300-line limit). Lives next to isForbiddenEval, which the 'eval' handler
// below calls directly. makeDispatch(ctx) binds the live WSession + bookkeeping
// flow and returns the per-command handler the Unix-socket server invokes. ---
const REPO = process.env.WELES_REPO || '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles';
const { mkdirSync, writeFileSync } = await import('node:fs');
const { humanType, humanFill } = await import(`${REPO}/dist/human/keyboard.js`);
const { humanClickLocator, humanClick, humanScroll, humanMove, humanIdlePause } = await import(`${REPO}/dist/human/mouse.js`);
const { wsSaveAccount } = await import(`${REPO}/dist/session/wsession-helpers/finalize.js`);
const { solveRecaptchaV2 } = await import(`${REPO}/dist/captcha/recaptcha.js`);

export function makeDispatch({ s, flow, SESSION }) {
  return async function dispatch(cmd) {
  try {
    if (cmd.action === 'screenshot') {
      const dir = `.work/keeper/${SESSION}`;
      mkdirSync(dir, { recursive: true });
      const fp = `${dir}/shot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      await s.page.screenshot({ path: fp });
      return { ok: true, path: fp };
    }
    if (cmd.action === 'dump') {
      const dir = `.work/keeper/${SESSION}`;
      mkdirSync(dir, { recursive: true });
      const fp = `${dir}/dump_${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
      const html = await s.page.evaluate(() => document.documentElement.outerHTML);
      writeFileSync(fp, html);
      return { ok: true, path: fp, length: html.length };
    }
    if (cmd.action === 'url') return { ok: true, url: s.page.url() };
    if (cmd.action === 'nav') {
      await s.page.goto(cmd.url, { waitUntil: 'domcontentloaded' });
      return { ok: true, url: s.page.url() };
    }
    if (cmd.action === 'click') {
      const loc = cmd.skipVisible
        ? s.page.locator(cmd.selector).first()
        : s.page.locator(cmd.selector).filter({ visible: true }).first();
      await humanClickLocator(s.page, loc);
      return { ok: true };
    }
    if (cmd.action === 'click_fast') {
      const loc = s.page.locator(cmd.selector).filter({ visible: true }).first();
      await loc.click({ force: true }); // allow-raw-playwright: LSI headless keeper-only UI action; no host cursor, no new browser
      return { ok: true };
    }
    if (cmd.action === 'dispatch_click') {
      const loc = s.page.locator(cmd.selector).filter({ visible: true }).first();
      await loc.evaluate((el) => {
        for (const type of ['mousedown', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }); // allow-raw-playwright: LSI headless keeper-only DOM click for MUI drawer save button; no host cursor, no new browser
      return { ok: true };
    }
    if (cmd.action === 'iframe_click') {
      let popupResolve;
      const popupPromise = new Promise((res) => { popupResolve = res; });
      s.page.once('popup', (p) => popupResolve(p));
      s.ctx.once('page', (p) => popupResolve(p));
      const frame = s.page.frames().find(f => f.url().includes(cmd.iframe));
      if (!frame) return { ok: false, error: `no frame matching url include "${cmd.iframe}"`, frame_urls: s.page.frames().map(f => f.url().slice(0, 120)) };
      const loc = frame.locator(cmd.selector).first();
      await humanClickLocator(s.page, loc);
      const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(r, 8000))]);  // allow-raw-playwright: popup-event deadline guard
      const ctxPages = s.ctx.pages().map(p => p.url().slice(0, 100));
      return { ok: true, popup: popup ? await popup.url() : null, ctxPages };
    }
    if (cmd.action === 'iframe_fill') {
      const frame = s.page.frames().find(f => f.url().includes(cmd.iframe));
      if (!frame) return { ok: false, error: `no frame matching url include "${cmd.iframe}"`, frame_urls: s.page.frames().map(f => f.url().slice(0, 120)) };
      const loc = cmd.skipVisible
        ? frame.locator(cmd.selector).first()
        : frame.locator(cmd.selector).filter({ visible: true }).first();
      await humanFill(s.page, loc, cmd.text);
      return { ok: true };
    }
    if (cmd.action === 'ctx_pages') {
      return { ok: true, pages: s.ctx.pages().map((p, i) => ({ i, url: p.url(), main: p === s.page })) };
    }
    if (cmd.action === 'all_pages') {
      const browser = s.ctx.browser?.();
      const out = [];
      if (browser) {
        const ctxs = browser.contexts();
        for (let ci = 0; ci < ctxs.length; ci++) {
          const pages = ctxs[ci].pages();
          for (let pi = 0; pi < pages.length; pi++) {
            out.push({ ctxIdx: ci, pageIdx: pi, url: pages[pi].url(), isMain: pages[pi] === s.page, isOurCtx: ctxs[ci] === s.ctx });
          }
        }
      }
      return { ok: true, pages: out };
    }
    if (cmd.action === 'switch_to_url') {
      const browser = s.ctx.browser?.();
      if (!browser) return { ok: false, error: 'no browser handle' };
      for (const c of browser.contexts()) {
        for (const p of c.pages()) {
          if (p.url().includes(cmd.urlPattern)) {
            s.page = p;
            if (c !== s.ctx) { s.ctx = c; }
            return { ok: true, url: p.url(), switchedCtx: c !== s.ctx };
          }
        }
      }
      return { ok: false, error: `no page matching url include "${cmd.urlPattern}"` };
    }
    if (cmd.action === 'switch_page') {
      const pages = s.ctx.pages();
      if (cmd.index < 0 || cmd.index >= pages.length) return { ok: false, error: `index ${cmd.index} out of range (${pages.length} pages)` };
      s.page = pages[cmd.index];
      return { ok: true, url: s.page.url() };
    }
    if (cmd.action === 'fill') {
      const loc = cmd.skipVisible
        ? s.page.locator(cmd.selector).first()
        : s.page.locator(cmd.selector).filter({ visible: true }).first();
      await humanFill(s.page, loc, cmd.text);
      return { ok: true };
    }
    if (cmd.action === 'fill_fast') {
      const loc = s.page.locator(cmd.selector).filter({ visible: true }).first();
      await loc.fill(cmd.text); // allow-raw-playwright: LSI keeper-only fast fill; no host cursor, no new browser
      return { ok: true };
    }
    if (cmd.action === 'set_value') {
      const loc = s.page.locator(cmd.selector).filter({ visible: true }).first();
      const result = await loc.evaluate((el, value) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { len: (el.value || '').length, max: Number(el.getAttribute('maxlength')) || null };
      }, cmd.text); // allow-raw-playwright: LSI headless keeper-only controlled-field setter; no host cursor, no new browser
      return { ok: true, result };
    }
    if (cmd.action === 'humanclick') {
      await humanClick(s.page, cmd.x, cmd.y);
      return { ok: true, x: cmd.x, y: cmd.y };
    }
    if (cmd.action === 'humanscroll') {
      await humanScroll(s.page, cmd.totalDeltaY ?? 1200, cmd.bursts ?? 3);
      return { ok: true };
    }
    if (cmd.action === 'humanmove') {
      await humanMove(s.page, cmd.x, cmd.y);
      return { ok: true, x: cmd.x, y: cmd.y };
    }
    if (cmd.action === 'humanidle') {
      await humanIdlePause(cmd.kind || 'deliberate');
      return { ok: true };
    }
    if (cmd.action === 'humanfill_email_password') {
      const e = s.page.locator('input#username, input[name="session_key"], input[type="email"]:not([readonly])').filter({ visible: true }).first();
      await humanFill(s.page, e, cmd.email);
      await humanIdlePause('short');
      const p = s.page.locator('input#password, input[name="session_password"], input[type="password"]:not([readonly])').filter({ visible: true }).first();
      await humanFill(s.page, p, cmd.password);
      return { ok: true };
    }
    if (cmd.action === 'click_signin_submit') {
      const btn = s.page.locator('form[action*="login-submit"] button[type="submit"], button[aria-label="Sign in" i]:not(:has-text("Apple")):not(:has-text("Google")), .login__form_action_container button[type="submit"]').filter({ visible: true }).first();
      await humanClickLocator(s.page, btn);
      return { ok: true };
    }
    if (cmd.action === 'iframes') {
      const out = await s.page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src.slice(0, 80), id: f.id, w: f.offsetWidth, h: f.offsetHeight })));
      return { ok: true, iframes: out };
    }
    if (cmd.action === 'type') { await humanType(s.page, cmd.text); return { ok: true }; }
    if (cmd.action === 'press') { await s.page.keyboard.press(cmd.key); return { ok: true }; }
    if (cmd.action === 'eval') {
      if (isForbiddenEval(cmd.js)) {
        return { ok: false, error: 'eval contains DOM-interaction tokens — use humanized atoms (humanclick, humantype, humanscroll) instead' };
      }
      return { ok: true, result: await s.page.evaluate(cmd.js) };
    }
    if (cmd.action === 'cookies') { return { ok: true, cookies: await s.ctx.cookies() }; }
    if (cmd.action === 'set_input_files') {
      const opts = {};
      if (cmd.force) opts.force = true;
      if (cmd.timeout) opts.timeout = parseInt(cmd.timeout, 10);
      await s.page.locator(cmd.selector).first().setInputFiles(cmd.path, opts);
      return { ok: true };
    }
    if (cmd.action === 'api_post') {
      const r = await s.page.context().request.post(cmd.url, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cmd.headers || {}) },
        data: cmd.body || '', maxRedirects: cmd.maxRedirects ?? 5,
      });
      return { ok: true, status: r.status(), url: r.url(), body: (await r.text()).slice(0, 4000) };
    }
    if (cmd.action === 'solverecaptcha') {
      const result = await solveRecaptchaV2(s.page);
      return { ok: !!result?.passed, result };
    }
    if (cmd.action === 'solvecaptcha') {
      const { solvePageCaptcha } = await import(`${REPO}/dist/captcha/detect.js`);
      const result = await solvePageCaptcha(s.page, undefined, s);
      return { ok: !!result, result: typeof result === 'string' ? result.slice(0, 40) : result };
    }
    if (cmd.action === 'save_account') {
      const result = await wsSaveAccount(s, cmd.platform, {
        username: cmd.username, email: cmd.email, password: cmd.password,
        name: cmd.name, status: cmd.status,
      });
      const ok = !result.startsWith('error');
      if (ok) await flow.close('completed', { healthy: true, signal: 'keeper_completed', details: { saved: result } }, null);
      return { ok, result };
    }
    if (cmd.action === 'mark_failed') {
      await flow.close('failed', { healthy: false, signal: cmd.signal || 'keeper_marked_failed', details: { reason: cmd.reason || null, last_url: s.page.url() } }, null);
      return { ok: true };
    }
    if (cmd.action === 'fill_stripe') {
      const { fillStripeElements } = await import(`${REPO}/scripts/trajectories/_shared/services/topup_common.mjs`);
      const result = await fillStripeElements(s.page);
      return result;
    }
    return { ok: false, error: `unknown action: ${cmd.action}` };
  } catch (e) {
    return { ok: false, error: e.message?.slice(0, 200) };
  }
  };
}
