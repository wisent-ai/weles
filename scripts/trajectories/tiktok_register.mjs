import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';
import { generatePersona } from '../../dist/browser/persona.js';
import { humanClickLocator } from '../../dist/human/mouse.js';

const URL = 'https://www.tiktok.com/signup';
const GOAL = `generate_identity(platform="tiktok"). Click "Use phone or email". Click "Sign up with email". For birthday use select_option(target="month",value=$TIKTOK_NEW_BIRTHMONTH), select_option(target="day",value=$TIKTOK_NEW_BIRTHDAY), select_option(target="year",value=$TIKTOK_NEW_BIRTHYEAR). Fill email with $TIKTOK_NEW_EMAIL. Fill password with $TIKTOK_NEW_PASSWORD. Click "Send code". check_email(email=$TIKTOK_NEW_EMAIL,sender="tiktok") for code. Fill code. Click Next. done(value=$TIKTOK_NEW_USERNAME).`;

if (process.env.TIKTOK_HARDCODED !== '1') {
  // Default: LLM-agent path
  const s = await WSession.start({ label: 'tiktok_register', proxy: process.env.PROXY_URL || 'residential' });
  try {
    await s.goto(URL);
    const result = await execute(s, `Open ${URL}. ${GOAL}`, { flowName: 'tiktok_register' });
    console.log('PASS:', result.value);
  } catch (e) {
    console.log('FAIL:', e.message?.slice(0, 200));
    process.exit(1);
  } finally {
    await s.close();
  }
} else {
  // Hardcoded trajectory — bypasses LLM agent
  // Retry the flow up to 3 times if browser/page dies during early setup (crash-prone with custom Chromium)
  let id = null, password = null, s = null, success = false;

  for (let retry = 0; retry < 3; retry++) {
    if (s) { await s.close().catch(() => {}); s = null; }

    s = await WSession.start({ label: 'tiktok_register', proxy: process.env.PROXY_URL || 'residential', persona: generatePersona({ country: 'US', browser: process.env.FORCE_BROWSER }) });
    try {
      // Fresh identity per retry — don't reuse emails across failed runs
      id = await s.generateIdentity('tiktok');
      // NO fixed prefix — TikTok decodes body; recurring prefix = counter key.
      const pfx = String.fromCharCode(65+Math.floor(Math.random()*26)) + Array.from({length:7},()=>String.fromCharCode(97+Math.floor(Math.random()*26))).join('');
      password = pfx + (100+Math.floor(Math.random()*900)) + '!@#$%&*'[Math.floor(Math.random()*7)];
      console.log(`[test] attempt ${retry + 1}: identity=${id.username} <${id.email}> bday=${id.birthMonth}/${id.birthDay}/${id.birthYear}`);

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

      // Plain Playwright fill — local Chromium has no password-typing block,
      // and Playwright's fill fires the exact InputEvent sequence React expects.
      await s.fill('Email', id.email);
      await s.fill('Password', password);
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
      for (let pw = 0; pw < 12; pw++) { await s.wait(2); probe = await s.page.evaluate(PROBE).catch(() => ({ error: true })); if (probe.hasResend || probe.indicators?.length) break; }
      console.log(`[test] After Send code: ${JSON.stringify(probe)}`);
      await s.screenshot(`after_send_code_r${retry}`).catch(() => {});

      if (!probe.hasResend) {
        console.log(`[test] attempt ${retry + 1}: Send code did not advance form (no Resend countdown). indicators=${probe.indicators?.join(',') || 'none'}`);
        // If it's rate-limit, don't retry
        if (probe.indicators?.includes('rate-limit')) { console.log('FAIL: TikTok rate-limited this session'); break; }
        // If captcha, log and give up for this attempt (will handle separately)
        if (probe.indicators?.length) { console.log(`FAIL: captcha detected — ${probe.indicators.join(',')}`); break; }
        continue;
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
      await humanClickLocator(s.page, s.page.locator('input[placeholder*="digit" i], input[name="code"]').first()).catch(() => {});
      for (const ch of code) { await s.page.keyboard.type(ch); await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 140))); }
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
      } else {
        console.log('[test] Next disabled, cannot submit');
        continue;
      }
      await s.wait(3);

      const clickLog = await s.page.evaluate(`JSON.stringify(window.__wclick || [])`).catch(() => '[]');
      console.log(`[test] clicks received: ${clickLog}`);

      // Wait for URL change OR post-submit state (captcha / username page / onboarding / foryou)
      let postUrl = s.page.url?.() ?? '';
      for (let w = 0; w < 30; w++) {
        await s.wait(2);
        postUrl = s.page.url?.() ?? '';
        const t = await s.page.evaluate('(document.body.innerText || "").slice(0, 600).toLowerCase()').catch(() => '');
        if (/foryou|\/@|onboarding|interests|choose.*username|profile picture|turn on notifications/i.test(postUrl + ' ' + t)) {
          console.log(`[test] post-next state found at wait ${w}: url=${postUrl}`); break;
        }
        if (/drag|puzzle|captcha|verify/i.test(t)) { console.log(`[test] captcha-like at wait ${w}: ${t.slice(0, 120)}`); break; }
        if (/incorrect|invalid|attempts reached|try again later|account.*already/i.test(t)) { console.log(`[test] error at wait ${w}: ${t.slice(0, 200)}`); break; }
      }
      await s.screenshot(`after_next_r${retry}`).catch(() => {});

      // Must leave the /signup/phone-or-email/email URL and land somewhere logged-in
      // for the account to really exist.
      if (postUrl.includes('/signup/phone-or-email/email')) {
        console.log(`[test] attempt ${retry + 1}: stuck on signup page — Next didn't create account`);
        continue;
      }

      // Optional username step
      const pageText = await s.page.evaluate('document.body.innerText').catch(() => '');
      if (/choose.*username|create a username|set a username/i.test(pageText)) {
        console.log('[test] username prompt detected, filling');
        await fillField('username', id.username).catch(() => s.fill('Username', id.username));
        await s.wait(1);
        const unBtn = await s.page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /next|continue|submit/i.test(x.textContent || '')); return { disabled: b?.disabled }; })()`).catch(() => ({}));
        if (unBtn.disabled === false) await humanClickLocator(s.page, s.page.locator('button:has-text("Next"), button:has-text("Continue")').first()).catch(() => {});
        await s.wait(5);
      }

      // Success: anywhere post-signup that looks logged-in
      const finalUrl = s.page.url?.() ?? '';
      const signedIn = /foryou|\/@|\/home|onboarding|interests/.test(finalUrl);
      if (signedIn) {
        await s.saveAccount('tiktok', { username: id.username, email: id.email, password });
        console.log(`PASS: ${id.username} (final url ${finalUrl})`);
        success = true;
        break;
      }
      console.log(`[test] attempt ${retry + 1}: didn't reach logged-in state. finalUrl=${finalUrl}`);
    } catch (e) {
      console.log(`[test] attempt ${retry + 1} crashed: ${e.message?.slice(0, 120)}`);
    }
  }

  if (s) await s.close().catch(() => {});
  if (!success) { console.log('FAIL: exhausted retries'); process.exit(1); }
}
