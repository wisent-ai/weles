// General persistent-browser keeper backed by full weles infrastructure.
//
// Replaces the prior vanilla-Playwright version. Now:
//   - WSession.start() handles proxy resolution, persona, patched
//     Chromium 147 fingerprint, recording.
//   - getSocialAccount(PLATFORM) sources the account so cookies + proxy
//     come from a real registered row, not a fresh anonymous context.
//   - All clicks/fills/types route through the weles humanized atoms
//     (humanClickLocator, humanFill, humanType) — never raw Playwright
//     locator.click() (which leaves event.isTrusted=false).
//   - Action sidecar talks over a Unix socket, no CDP debug port exposed.
//
// Env:
//   SESSION   — namespace for socket + output dir (default "default")
//   PLATFORM  — getSocialAccount target (e.g. "linkedin")
//   URL       — optional initial navigation
//   JAR       — optional explicit cookie-jar JSON path
//   HEADLESS  — "1" for headless (default: visible)

import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REPO = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles';
const { WSession } = await import(`${REPO}/dist/session/wsession.js`);
const { getSocialAccount, resolveAccountSession } = await import(`${REPO}/dist/utils/credentials.js`);
const { humanType, humanFill } = await import(`${REPO}/dist/human/keyboard.js`);
const { humanClickLocator, humanClick, humanScroll, humanMove, humanIdlePause } = await import(`${REPO}/dist/human/mouse.js`);
const { wsSaveAccount } = await import(`${REPO}/dist/session/wsession-helpers/finalize.js`);
const { solveRecaptchaV2 } = await import(`${REPO}/dist/captcha/recaptcha.js`);

const SESSION = process.env.SESSION || 'default';
const PLATFORM = process.env.PLATFORM || '';
const URL_ARG = process.env.URL || '';
const JAR_PATH = process.env.JAR || '';
const HEADLESS = process.env.HEADLESS === '1';

const KEEPER_DIR = join(homedir(), '.weles', 'keeper', SESSION);
mkdirSync(KEEPER_DIR, { recursive: true });
const SOCK_PATH = join(KEEPER_DIR, 'socket');
if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);

let proxy, persona, acct = null;
if (PLATFORM) {
  acct = await getSocialAccount(PLATFORM);
  if (acct) {
    const opts = await resolveAccountSession(acct);
    proxy = opts.proxyUrl;
    persona = opts.persona;
    console.log(`[keeper:${SESSION}] account=${acct.username} proxy=${proxy ? 'set' : 'none'}`);
  } else {
    console.log(`[keeper:${SESSION}] PLATFORM=${PLATFORM} but no account — anonymous context`);
  }
}
if (!proxy && process.env.PROXY_URL) {
  proxy = process.env.PROXY_URL;
  console.log(`[keeper:${SESSION}] using PROXY_URL env override`);
}

const s = await WSession.start({ label: `keeper-${SESSION}`, proxy, persona, headless: HEADLESS });
console.log(`[keeper:${SESSION}] WSession started`);

// Cookie injection: explicit JAR path wins, else use account's metadata.cookies.
if (JAR_PATH && existsSync(JAR_PATH)) {
  try {
    const raw = JSON.parse(readFileSync(JAR_PATH, 'utf8'));
    const cookies = Array.isArray(raw) ? raw : (raw.cookies || []);
    if (cookies.length) await s.ctx.addCookies(cookies);
    console.log(`[keeper:${SESSION}] injected ${cookies.length} cookies from ${JAR_PATH}`);
  } catch (e) { console.log(`[keeper:${SESSION}] jar err: ${e.message?.slice(0, 80)}`); }
} else if (acct?.metadata?.cookies?.length) {
  try {
    const cs = acct.metadata.cookies.filter(c => c.name && c.value).map(c => ({
      ...c,
      sameSite: c.sameSite === 'no_restriction' ? 'None'
              : c.sameSite === 'lax' ? 'Lax'
              : c.sameSite === 'strict' ? 'Strict' : 'Lax',
    }));
    if (cs.length) await s.ctx.addCookies(cs);
    console.log(`[keeper:${SESSION}] injected ${cs.length} cookies from account`);
  } catch (e) { console.log(`[keeper:${SESSION}] cookie inject err: ${e.message?.slice(0, 80)}`); }
}

if (URL_ARG) {
  await s.page.goto(URL_ARG, { waitUntil: 'domcontentloaded' }).catch((e) =>
    console.log(`[keeper:${SESSION}] goto warn: ${e.message?.slice(0, 80)}`)
  );
  console.log(`[keeper:${SESSION}] at ${s.page.url()}`);
}

async function dispatch(cmd) {
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
    if (cmd.action === 'ctx_pages') {
      return { ok: true, pages: s.ctx.pages().map((p, i) => ({ i, url: p.url(), main: p === s.page })) };
    }
    if (cmd.action === 'all_pages') {
      // List pages across ALL contexts in the browser (catches popups that land
      // in a separate BrowserContext that ctx.pages() doesn't track).
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
      // Switch s.page to the first page across all contexts whose URL matches cmd.urlPattern.
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
    // Composite captcha-solver actions (solverecaptcha, solvePerimeterX)
    // were removed: they ran their own internal screenshot/classify/click
    // loops inside the keeper, hiding every intermediate state from the
    // outer agent. The keeper exposes only atomic actions; the agent
    // (multimodal Claude) is the classifier and runs the loop one step
    // at a time with a Read between each.
    if (cmd.action === 'humanfill_email_password') {
      const e = s.page.locator('input#username, input[name="session_key"], input[type="email"]:not([readonly])').filter({ visible: true }).first();
      await humanFill(s.page, e, cmd.email);
      await humanIdlePause('short');
      const p = s.page.locator('input#password, input[name="session_password"], input[type="password"]:not([readonly])').filter({ visible: true }).first();
      await humanFill(s.page, p, cmd.password);
      return { ok: true };
    }
    if (cmd.action === 'click_signin_submit') {
      // Avoid Apple/Google SSO buttons. Target the form's primary submit.
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
      const { isForbiddenEval } = await import('./eval_guard.mjs');
      if (isForbiddenEval(cmd.js)) {
        return { ok: false, error: 'eval contains DOM-interaction tokens — use humanized atoms (humanclick, humantype, humanscroll) instead' };
      }
      return { ok: true, result: await s.page.evaluate(cmd.js) };
    }
    if (cmd.action === 'cookies') { return { ok: true, cookies: await s.ctx.cookies() }; }
    if (cmd.action === 'solverecaptcha') {
      const result = await solveRecaptchaV2(s.page);
      return { ok: !!result?.passed, result };
    }
    if (cmd.action === 'solvecaptcha') {
      // Generic detect+solve (hCaptcha/reCAPTCHA/Turnstile) via the
      // capsolver/capmonster-backed solvePageCaptcha. Discord login uses
      // hCaptcha which solveRecaptchaV2 cannot handle. Passing the WSession
      // enables the Discord intercepted-API captcha path
      // (session.captchaResponse.captcha_sitekey). Returns true/token on
      // success, true when no captcha present.
      const { solvePageCaptcha } = await import(`${REPO}/dist/captcha/detect.js`);
      const result = await solvePageCaptcha(s.page, undefined, s);
      return { ok: !!result, result: typeof result === 'string' ? result.slice(0, 40) : result };
    }
    if (cmd.action === 'save_account') {
      const result = await wsSaveAccount(s, cmd.platform, {
        username: cmd.username, email: cmd.email, password: cmd.password,
        name: cmd.name, status: cmd.status,
      });
      return { ok: !result.startsWith('error'), result };
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
}

const server = net.createServer((conn) => {
  let buf = '';
  conn.on('data', async (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const cmd = JSON.parse(line);
        const res = await dispatch(cmd);
        conn.write(JSON.stringify(res) + '\n');
      } catch (e) {
        conn.write(JSON.stringify({ ok: false, error: e.message?.slice(0, 200) }) + '\n');
      }
    }
  });
});
server.listen(SOCK_PATH, () => {
  console.log(`[keeper:${SESSION}] listening on ${SOCK_PATH}`);
  console.log(`[keeper:${SESSION}] === IDLE — drive via SESSION=${SESSION} node action.mjs <cmd> ===`);
});

await new Promise(() => {});
