import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';
import { humanClickLocator } from '../../dist/human/mouse.js';
import { reportBlocked } from '../../dist/utils/email/domain.js';
import { generateIdentity } from '../../dist/utils/identity.js';

const URL = 'https://www.tiktok.com/signup';

async function syncReactInputValue(locator, value) {
  await locator.evaluate((el, v) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    // React keeps a private value tracker and ignores input events if it
    // believes the value did not change. Reset the tracker before dispatch.
    el._valueTracker?.setValue('');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value).catch(() => {});
}

{
  // Single deterministic path — phone-or-email → email tab → fill DOB+email+
  // password → send code → poll Resend → verify code → land on /foryou.
  // Retry the flow up to 3 times if browser/page dies during early setup (crash-prone with custom Chromium)
  let id = null, password = null, s = null, success = false;

  const maxRetries = Math.max(1, Number(process.env.MAX_RETRIES || 3));
  for (let retry = 0; retry < maxRetries; retry++) {
    if (s) { await s.close().catch(() => {}); s = null; }
    let registerVerifyErrorCode = null;
    let registerVerifySeen = false;
    let sendCodeSeen = false;
    let sendCodeSuccess = false;

    try {
      // Fresh identity per retry — don't reuse emails across failed runs
      id = await generateIdentity('tiktok');
      // NO fixed prefix — TikTok decodes body; recurring prefix = counter key.
      const pfx = String.fromCharCode(65+Math.floor(Math.random()*26)) + Array.from({length:7},()=>String.fromCharCode(97+Math.floor(Math.random()*26))).join('');
      password = pfx + (100+Math.floor(Math.random()*900)) + '!@#$%&*'[Math.floor(Math.random()*7)];
      console.log(`[test] attempt ${retry + 1}: identity=${id.username} <${id.email}> bday=${id.birthMonth}/${id.birthDay}/${id.birthYear}`);

      // Pin chromium — humanMove uses CDP-routed Page.dispatchMouseEvent which
      // is Chromium-only. Firefox crashes with "synthesizeMouseEvent is not a
      // function" on the very first click. Default persona randomization is
      // 60/40 chromium/firefox; for a trajectory that must drive humanMove,
      // we hard-pin Chromium.
      s = await WSession.start({ label: 'tiktok_register', proxy: process.env.PROXY_URL || 'residential brightdata', targetHost: 'www.tiktok.com', persona: generatePersona({ country: 'US', browser: process.env.FORCE_BROWSER || 'chromium' }) });

      // Full request+response logging for interesting endpoints.
      // Focus on /region/ since that's where brendawatsica had len=204 (with captcha_domain) and current has len=23.
      const interesting = (u) => /send_code|check_code|passport\/web\/region|passport\/web\/email|passport\/web\/user\/register|passport\/web\/register|verification\/age|captcha|verify/.test(u || '');
      s.page.on('request', (req) => {
        const u = req.url();
        if (!interesting(u)) return;
        const body = (() => { try { return req.postData() || ''; } catch { return ''; } })();
        const h = req.headers();
        const ttHeaders = Object.keys(h).filter(k => /tt-|ticket|passport|csrf|x-ms|x-bogus|signature/i.test(k));
        console.log(`[req] ${req.method()} ${u.slice(0, 140)}`);
        if (ttHeaders.length) console.log(`[req-tt-hdrs] ${ttHeaders.map(k => k + '=' + (h[k] || '').slice(0, 120)).join(' | ')}`);
        else console.log(`[req-tt-hdrs] NONE — header keys: ${Object.keys(h).join(',')}`);
        if (body) console.log(`[req-body] ${body.slice(0, 400)}`);
        if (/email\/send_code/i.test(u)) sendCodeSeen = true;
        if (/register_verify_login/i.test(u)) registerVerifySeen = true;
      });
      s.page.on('response', async (resp) => {
        const u = resp.url();
        if (!interesting(u)) return;
        let body = '';
        try { body = (await resp.text()); } catch {}
        const h = resp.headers();
        const hdrJson = JSON.stringify(h);
        console.log(`[res] ${resp.status()} ${u.slice(0, 140)}`);
        console.log(`[res-body] ${body.slice(0, 500).replace(/\s+/g, ' ')}`);
        console.log(`[res-hdrs] ${hdrJson.slice(0, 600)}`);
        if (/email\/send_code/i.test(u)) {
          try {
            const parsed = JSON.parse(body);
            if (parsed?.message === 'success') sendCodeSuccess = true;
            console.log(`[test] send_code message=${parsed?.message ?? 'missing'}`);
          } catch {}
        }
        if (/register_verify_login/i.test(u)) {
          registerVerifySeen = true;
          try {
            const parsed = JSON.parse(body);
            registerVerifyErrorCode = parsed?.data?.error_code ?? parsed?.error_code ?? null;
            console.log(`[test] register_verify_login error_code=${registerVerifyErrorCode ?? 'missing'}`);
          } catch {}
        }
      });

      for (const u of ['https://www.tiktok.com/','https://www.tiktok.com/explore']) { await s.page.goto(u,{waitUntil:'domcontentloaded'}).catch(()=>{}); await s.wait(3); }
      await s.goto(URL); await s.wait(3);

      // Verify page is alive
      const alive = await s.page.evaluate('document.querySelector("body") !== null').catch(() => false);
      if (!alive) { console.log(`[test] attempt ${retry + 1}: page died after goto`); continue; }

      // Dismiss cookie banner if EU/UK proxy
      for (const sel of ['button:has-text("Decline optional cookies")', 'button:has-text("Accept all")', 'button:has-text("Allow all")']) {
        try {
          const btn = s.page.locator(sel).first();
          if (await btn.isVisible().catch(() => false)) { await humanClickLocator(s.page, btn); console.log(`[test] Dismissed cookie banner`); break; }
        } catch {}
      }

      // Click "Use phone or email" — retry until URL advances past /signup
      for (let cs = 0; cs < 4; cs++) {
        const urlBefore = s.page.url?.() ?? '';
        if (urlBefore.includes('/phone-or-email')) break;
        await s.click('Use phone or email');
        await s.wait(3);
      }
      const urlAfterChannel = s.page.url?.() ?? '';
      if (!urlAfterChannel.includes('/phone-or-email')) {
        console.log(`[test] attempt ${retry + 1}: stuck at ${urlAfterChannel}`); continue;
      }

      // Click "Sign up with email" if still on /phone page
      for (let cs = 0; cs < 3; cs++) {
        const u = s.page.url?.() ?? '';
        if (u.includes('/email')) break;
        await s.click('Sign up with email');
        await s.wait(2);
      }
      if (!(s.page.url?.() ?? '').includes('/email')) {
        console.log(`[test] attempt ${retry + 1}: couldn't switch to email tab`); continue;
      }

      // Select birthday
      await s.select('month', id.birthMonth);
      await s.select('day', id.birthDay);
      await s.select('year', id.birthYear);
      await s.wait(1);

      // Email — humanFill via s.fill works for plain text inputs.
      await s.fill('Email', id.email);
      // Password — TikTok's password input has a show/hide eye toggle whose
      // <i role="button"> sits inside the input's bounding box (rightmost
      // ~52px). humanClickLocator's randomized in-element offset can hit the
      // toggle (or trigger TikTok's React handler that swaps type=password
      // for type=text and re-mounts the input), leaving the focused element
      // detached so subsequent CDP keystrokes write nothing — pwLen=0 and
      // the Next button stays disabled. Workaround: focus() the input
      // directly (no pointer click, no toggle hit), then dispatch keystrokes
      // via humanType. Verified 2026-04-30: pwLen matches len(password)
      // and Next becomes enabled after entering the verification code.
      const pwLoc = s.page.locator('input[placeholder="Password"], input[type="password"]').first();
      if (await pwLoc.count()) {
        const { humanType } = await import('../../dist/human/keyboard.js');
        await pwLoc.focus();
        await s.wait(1);
        await s.page.keyboard.press('ControlOrMeta+A').catch(() => {});
        await s.page.keyboard.press('Delete').catch(() => {});
        await humanType(s.page, password);
      }
      await s.wait(1);
      // Tab out of password — fires React onBlur, dismisses "password must have..." error
      await s.page.keyboard.press('Tab').catch(() => {});
      await s.wait(1);
      const verify = await s.page.evaluate(`(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const email = inputs.find(i => (i.placeholder || '').toLowerCase().includes('email'));
        const pw = inputs.find(i => (i.placeholder || '').toLowerCase().includes('password'));
        const sendBtn = document.querySelector('[data-e2e="send-code-button"]');
        const errors = Array.from(document.querySelectorAll('[class*="error"], [class*="Error"], [class*="tip"], [class*="Tip"]'))
          .map(e => (e.textContent || '').trim()).filter(t => t && t.length < 200);
        const pageText = (document.body.innerText || '').slice(0, 500);
        return {
          emailLen: email?.value?.length,
          pwLen: pw?.value?.length,
          sendDisabled: sendBtn?.disabled,
          sendAriaDisabled: sendBtn?.getAttribute('aria-disabled'),
          errors: errors.slice(0, 8),
          bodyExcerpt: pageText,
        };
      })()`).catch((e) => ({ error: e.message }));
      console.log(`[test] fill verify: ${JSON.stringify(verify)}`);
      // Humanized fill — replaces descriptor-set + dispatch('input') which
      // bypassed all keystrokes (anti-bot signal that TikTok's signup ML reads).
      const { humanFill } = await import('../../dist/human/keyboard.js');
      const fillField = async (placeholder, val) => {
        const loc = s.page.locator(`input[placeholder*="${placeholder}" i]`).first();
        if (!(await loc.count())) return { ok: false, reason: 'not-found' };
        await humanFill(s.page, loc, val);
        return { ok: true, len: val.length };
      };
      await s.wait(2);

      // Capture Send code button rect + install click listener so we can see what actually got clicked.
      const sendInfo = await s.page.evaluate(`(() => {
        const btn = document.querySelector('[data-e2e="send-code-button"]');
        if (!btn) return { present: false };
        const r = btn.getBoundingClientRect();
        window.__wclick = [];
        document.addEventListener('click', e => {
          const el = e.target;
          const r2 = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
          window.__wclick.push({
            tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40),
            dataE2e: el.getAttribute && el.getAttribute('data-e2e'),
            isTrusted: e.isTrusted, clientX: e.clientX, clientY: e.clientY,
            targetRect: { x: r2.x, y: r2.y, w: r2.width, h: r2.height },
          });
        }, true);
        return { present: true, disabled: btn.disabled, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, center: { x: r.x + r.width/2, y: r.y + r.height/2 } };
      })()`).catch((e) => ({ error: e.message }));
      console.log(`[test] send button: ${JSON.stringify(sendInfo)}`);
      if (sendInfo.disabled === false) {
        const r = await s.click('Send code');
        console.log(`[test] s.click('Send code') => ${r}`);
      } else {
        console.log('[test] Send button disabled — skipping');
        continue;
      }
      // Captcha SDK init + silent-challenge solve before /send_code/ fires
      // takes 8-20s after the click. Poll up to 25s for the "Resend code"
      // countdown or a captcha/rate-limit indicator to appear.
      let probe = { hasResend: false, indicators: [] };
      const PROBE = `(() => { const t = document.body.innerText || ''; const i = []; if (document.querySelector('.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]')) i.push('captcha-container'); if (document.querySelector('iframe[src*="captcha"]')) i.push('captcha-iframe'); if (/drag|puzzle|rotate|slide/i.test(t)) i.push('captcha-text'); if (/too many|attempts|try again later/i.test(t)) i.push('rate-limit'); return { indicators: i, hasResend: /Resend code/i.test(t), url: location.href }; })()`;
      for (let pw = 0; pw < 25; pw++) {
        await s.wait(2);
        probe = await s.page.evaluate(PROBE).catch(() => ({ error: true }));
        if (probe.hasResend || sendCodeSuccess || probe.indicators?.length) break;
      }
      console.log(`[test] After Send code: ${JSON.stringify(probe)}`);
      await s.screenshot(`after_send_code_r${retry}`).catch(() => {});

      if (!probe.hasResend && !sendCodeSuccess) {
        console.log(`[test] attempt ${retry + 1}: Send code did not advance form (no Resend countdown). indicators=${probe.indicators?.join(',') || 'none'}`);
        // If it's rate-limit, don't retry
        if (probe.indicators?.includes('rate-limit')) { console.log('FAIL: TikTok rate-limited this session'); break; }
        // If captcha, log and give up for this attempt (will handle separately)
        if (probe.indicators?.length) { console.log(`FAIL: captcha detected — ${probe.indicators.join(',')}`); break; }
        continue;
      }
      if (!probe.hasResend && sendCodeSuccess) {
        console.log('[test] send_code API succeeded although countdown text did not render — polling inbox anyway');
      }

      // Poll Resend for verification code
      console.log(`[test] Polling email for ${id.email}...`);
      const code = await s.checkEmail(id.email, 'tiktok');
      if (!code || code === 'no code received' || !/^\d{4,8}$/.test(code)) {
        console.log(`[test] attempt ${retry + 1}: no code (${code})`);
        continue;
      }
      console.log(`[test] Got code: ${code}`);

      // Type code char-by-char w/ variable delays — one burst via DOM setter looks
      // unlike real typing; React form sees each keystroke as separate input event.
      const codeLoc = s.page.locator('input[placeholder*="digit" i], input[name="code"]').first();
      await humanClickLocator(s.page, codeLoc).catch(() => {});
      for (const ch of code) { await s.page.keyboard.type(ch); await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 140))); }
      // Reconcile React state only after send_code has succeeded. Doing this
      // before send_code changed TikTok's challenge path and stalled the flow.
      if (await pwLoc.count().catch(() => 0)) await syncReactInputValue(pwLoc, password);
      await syncReactInputValue(codeLoc, code);
      await s.page.keyboard.press('Tab').catch(() => {}); await s.wait(1);

      // Capture button position + install click listener BEFORE we click anything.
      // This tells us exactly where the Next button sits and which element actually received the click.
      const nextInfo = await s.page.evaluate(`(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => /^\\s*next\\s*$/i.test((b.textContent || '').trim()));
        if (!btn) return { present: false };
        const r = btn.getBoundingClientRect();
        window.__wclick = [];
        document.addEventListener('click', e => {
          const el = e.target;
          const r2 = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
          window.__wclick.push({
            tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40),
            id: el.id, cls: (el.className || '').toString().slice(0, 60),
            isTrusted: e.isTrusted, clientX: e.clientX, clientY: e.clientY,
            targetRect: { x: r2.x, y: r2.y, w: r2.width, h: r2.height },
          });
        }, true);
        return { present: true, disabled: btn.disabled, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, center: { x: r.x + r.width/2, y: r.y + r.height/2 } };
      })()`).catch((e) => ({ error: e.message }));
      console.log(`[test] Next button: ${JSON.stringify(nextInfo)}`);

      if (nextInfo.disabled === false) {
        // Try humanClick via s.click (what worked for Send code)
        const r = await s.click('Next');
        console.log(`[test] s.click('Next') => ${r}`);
        await s.wait(2);
        if (!registerVerifySeen && (s.page.url?.() ?? '').includes('/signup/phone-or-email/email')) {
          console.log('[test] Next click produced no register_verify_login request — trying keyboard activation');
          const nextBtn = s.page.getByRole('button', { name: /^\s*Next\s*$/i }).first();
          await nextBtn.focus().catch(() => {});
          await s.page.keyboard.press('Enter').catch(() => {});
          await s.wait(2);
          if (!registerVerifySeen) {
            await s.page.keyboard.press('Space').catch(() => {});
            await s.wait(2);
          }
          if (!registerVerifySeen && await nextBtn.isVisible().catch(() => false)) {
            await humanClickLocator(s.page, nextBtn).catch(() => {});
            await s.wait(2);
          }
        }
      } else {
        console.log('[test] Next disabled, cannot submit');
        continue;
      }
      await s.wait(3);

      const clickLog = await s.page.evaluate(`JSON.stringify(window.__wclick || [])`).catch(() => '[]');
      console.log(`[test] clicks received: ${clickLog}`);

      // Wait for URL change OR post-submit state. Once Next clicks succeed,
      // TikTok routes to /signup/create-username (the username-creation step
      // — at this point the account is created server-side, sessionid cookie
      // is set; we just need to finalize username). Other terminal states:
      // /foryou (logged in directly), interests/onboarding pages, captcha
      // modal, or an inline error.
      let postUrl = s.page.url?.() ?? '';
      for (let w = 0; w < 30; w++) {
        await s.wait(2);
        postUrl = s.page.url?.() ?? '';
        const t = await s.page.evaluate('(document.body.innerText || "").slice(0, 600).toLowerCase()').catch(() => '');
        if (/create-username|foryou|\/@|onboarding|interests|choose.*username|create a username|profile picture|turn on notifications/i.test(postUrl + ' ' + t)) {
          console.log(`[test] post-next state found at wait ${w}: url=${postUrl}`); break;
        }
        if (/drag|puzzle|captcha|verify/i.test(t)) { console.log(`[test] captcha-like at wait ${w}: ${t.slice(0, 120)}`); break; }
        if (/incorrect|invalid|attempts reached|try again later|account.*already/i.test(t)) { console.log(`[test] error at wait ${w}: ${t.slice(0, 200)}`); break; }
      }
      await s.screenshot(`after_next_r${retry}`).catch(() => {});

      // Must leave the /signup/phone-or-email/email URL — if we're still
      // there, Next didn't trigger registration server-side.
      if (postUrl.includes('/signup/phone-or-email/email')) {
        console.log(`[test] attempt ${retry + 1}: stuck on signup page — Next didn't create account`);
        continue;
      }

      // Username creation step: TikTok routes here on successful registration.
      // Account exists at this point (sessionid cookie set), but we need to
      // pick a username so the auth state finalizes.
      const pageText = await s.page.evaluate('document.body.innerText').catch(() => '');
      const nowOnUsernameStep = /\/signup\/create-username/.test(postUrl) ||
                                /create.{0,3}username|choose.{0,3}username|set.{0,3}username/i.test(pageText);
      if (nowOnUsernameStep) {
        console.log('[test] username step detected — filling');
        // Probe the input + button (helps debug if TikTok renames placeholders).
        const unInfo = await s.page.evaluate(`(() => {
          const inputs = Array.from(document.querySelectorAll('input')).filter(i => {
            const r = i.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && i.offsetParent !== null;
          }).map(i => ({ placeholder: i.placeholder, name: i.name, type: i.type, valueLen: (i.value || '').length }));
          const btns = Array.from(document.querySelectorAll('button')).filter(b => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && b.offsetParent !== null;
          }).map(b => ({ text: (b.textContent || '').trim().slice(0, 30), disabled: b.disabled }));
          return { inputs, btns };
        })()`).catch(() => ({}));
        console.log(`[test] username step DOM: ${JSON.stringify(unInfo).slice(0, 600)}`);

        // Fill username via the same focus()-then-humanType workaround we
        // use for password (TikTok's create-username input may also have
        // suffix toggles; safer to skip humanClickLocator).
        const unLoc = s.page.locator('input[placeholder*="username" i], input[name*="username" i]').first();
        if (await unLoc.count()) {
          const { humanType } = await import('../../dist/human/keyboard.js');
          await unLoc.focus();
          await s.wait(1);
          await s.page.keyboard.press('ControlOrMeta+A').catch(() => {});
          await s.page.keyboard.press('Delete').catch(() => {});
          await humanType(s.page, id.username);
          await s.wait(2);
        }

        // Read whatever value TikTok actually accepted (it auto-prefixes,
        // truncates, or rejects suggestions and adds digits). Save the
        // post-fill value so DB gets the real username, not what we typed.
        const acceptedUsername = await s.page.evaluate(`(() => {
          const inp = document.querySelector('input[placeholder*="username" i], input[name*="username" i]');
          return inp ? (inp.value || '') : '';
        })()`).catch(() => '');
        const finalUsername = acceptedUsername || id.username;
        console.log(`[test] username field value=${JSON.stringify(acceptedUsername)} chosen=${JSON.stringify(finalUsername)}`);

        // Click the submit button. Text varies: "Sign up", "Next", "Continue".
        // Try each in order until one is visible + enabled.
        for (const txt of ['Sign up', 'Next', 'Continue', 'Done']) {
          try {
            const btn = s.page.getByRole('button', { name: new RegExp(`^\\s*${txt}\\s*$`, 'i') }).first();
            if ((await btn.count()) && await btn.isVisible({ timeout: 1500 }).catch(() => false) && !(await btn.isDisabled().catch(() => false))) {
              await humanClickLocator(s.page, btn);
              console.log(`[test] clicked ${txt} on username step`);
              break;
            }
          } catch {}
        }

        // Wait up to 30s for redirect away from /signup/create-username.
        // TikTok then routes to interest selection / profile picture / foryou.
        for (let w = 0; w < 15; w++) {
          await s.wait(2);
          const u = s.page.url?.() ?? '';
          if (!u.includes('/signup/create-username')) { console.log(`[test] left create-username at wait ${w}: ${u}`); break; }
        }
        // Update the identity we'll save with the actual username TikTok kept.
        id.username = finalUsername;
      }

      // Success: anywhere post-signup that looks logged-in (or that had to
      // come from a successful register_verify_login response — even
      // /signup/create-username counts because the account is created at
      // that point and sessionid is set).
      const finalUrl = s.page.url?.() ?? '';
      const hasSessionId = await s.page.evaluate('document.cookie.includes("sessionid")').catch(() => false);
      const signedIn = hasSessionId || /foryou|\/@|\/home|onboarding|interests|create-username/.test(finalUrl);
      if (signedIn) {
        await s.saveAccount('tiktok', { username: id.username, email: id.email, password });
        console.log(`PASS: ${id.username} (final url ${finalUrl}, sessionid=${hasSessionId})`);
        success = true;
        break;
      }
      console.log(`[test] attempt ${retry + 1}: didn't reach logged-in state. finalUrl=${finalUrl} sessionid=${hasSessionId}`);
      // 1340 != domain reputation. Do NOT quarantine — root cause is subtleCrypto.count=0.
    } catch (e) {
      console.log(`[test] attempt ${retry + 1} crashed: ${e.message?.slice(0, 120)}`);
    }
  }

  if (s) await s.close().catch(() => {});
  if (!success) { console.log('FAIL: exhausted retries'); process.exit(1); }
}
