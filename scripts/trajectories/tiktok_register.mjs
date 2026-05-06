import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';
import { humanClickLocator } from '../../dist/human/mouse.js';
import { reportBlocked } from '../../dist/utils/email/domain.js';
import { generateIdentity } from '../../dist/utils/identity.js';
import { autoBindCharacter } from './lib/character-bind.mjs';
import { syncReactInputValue, installNetworkLogger, runUsernameStep } from './lib/tiktok-register-helpers.mjs';

const URL = 'https://www.tiktok.com/signup';

{
  // Single deterministic path — phone-or-email → email tab → fill DOB+email+
  // password → send code → poll Resend → verify code → land on /foryou.
  // Retry the flow up to 3 times if browser/page dies during early setup.
  let id = null, password = null, s = null, success = false;

  const maxRetries = Math.max(1, Number(process.env.MAX_RETRIES || 1));
  for (let retry = 0; retry < maxRetries; retry++) {
    if (s) { await s.close().catch(() => {}); s = null; }

    try {
      // Fresh identity per retry — don't reuse emails across failed runs
      id = await generateIdentity('tiktok');
      // NO fixed prefix — TikTok decodes body; recurring prefix = counter key.
      const pfx = String.fromCharCode(65+Math.floor(Math.random()*26)) + Array.from({length:7},()=>String.fromCharCode(97+Math.floor(Math.random()*26))).join('');
      password = pfx + (100+Math.floor(Math.random()*900)) + '!@#$%&*'[Math.floor(Math.random()*7)];
      console.log(`[test] attempt ${retry + 1}: identity=${id.username} <${id.email}> bday=${id.birthMonth}/${id.birthDay}/${id.birthYear}`);

      // Pin chromium — humanMove uses CDP-routed Page.dispatchMouseEvent
      // which is Chromium-only. Firefox crashes with "synthesizeMouseEvent
      // is not a function" on the first click.
      s = await WSession.start({ label: 'tiktok_register', proxy: process.env.PROXY_URL || 'residential brightdata', targetHost: 'www.tiktok.com', persona: generatePersona({ country: 'US', browser: process.env.FORCE_BROWSER || 'chromium' }) });
      const net = installNetworkLogger(s);

      for (const u of ['https://www.tiktok.com/','https://www.tiktok.com/explore']) { await s.page.goto(u,{waitUntil:'domcontentloaded'}).catch(()=>{}); await s.wait(3); }
      await s.goto(URL); await s.wait(3);

      // Verify page is alive
      const alive = await s.page.evaluate('document.querySelector("body") !== null').catch(() => false);
      if (!alive) { console.log(`[test] attempt ${retry + 1}: page died after goto`); continue; }
      // Browser-time vregion check. HTTP preflight verifies the FIRST exit
      // IP; BrightData rotates exits within a sticky. SIGI_STATE pins mssdk
      // routing — TTP2 = click handler bails. Abort + reroll.
      const vregion = await s.page.evaluate(`(() => { const m = (document.body.innerHTML || '').match(/"vregion":"([A-Z0-9-]{1,20})"/); return m ? m[1] : null; })()`).catch(() => null);
      console.log(`[test] attempt ${retry + 1}: browser-time vregion=${vregion}`);
      if (vregion && /-TTP2$/i.test(vregion)) { console.log(`[test] attempt ${retry + 1}: vregion=${vregion} — aborting + rerolling sticky`); continue; }

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
      // Password — TikTok's input has a show/hide eye toggle inside the
      // bounding box (~52px from the right). humanClickLocator's randomized
      // in-element offset can hit the toggle, leaving the focused element
      // detached. Workaround: focus() the input directly (no pointer
      // click), then dispatch keystrokes via humanType.
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
      // Tab out of password — fires React onBlur, dismisses error banner
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
        return { emailLen: email?.value?.length, pwLen: pw?.value?.length, sendDisabled: sendBtn?.disabled, sendAriaDisabled: sendBtn?.getAttribute('aria-disabled'), errors: errors.slice(0, 8), bodyExcerpt: pageText };
      })()`).catch((e) => ({ error: e.message }));
      console.log(`[test] fill verify: ${JSON.stringify(verify)}`);
      await s.wait(2);

      // Capture Send code button rect + install click listener
      const sendInfo = await s.page.evaluate(`(() => {
        const btn = document.querySelector('[data-e2e="send-code-button"]');
        if (!btn) return { present: false };
        const r = btn.getBoundingClientRect();
        window.__wclick = [];
        document.addEventListener('click', e => {
          const el = e.target;
          const r2 = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
          window.__wclick.push({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40), dataE2e: el.getAttribute && el.getAttribute('data-e2e'), isTrusted: e.isTrusted, clientX: e.clientX, clientY: e.clientY, targetRect: { x: r2.x, y: r2.y, w: r2.width, h: r2.height } });
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
      // takes 8-20s. Poll up to 25s for "Resend code" countdown or a
      // captcha/rate-limit indicator.
      let probe = { hasResend: false, indicators: [] };
      const PROBE = `(() => { const t = document.body.innerText || ''; const i = []; if (document.querySelector('.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]')) i.push('captcha-container'); if (document.querySelector('iframe[src*="captcha"]')) i.push('captcha-iframe'); if (/drag|puzzle|rotate|slide/i.test(t)) i.push('captcha-text'); if (/too many|attempts|try again later/i.test(t)) i.push('rate-limit'); return { indicators: i, hasResend: /Resend code/i.test(t), url: location.href }; })()`;
      for (let pw = 0; pw < 25; pw++) {
        await s.wait(2);
        probe = await s.page.evaluate(PROBE).catch(() => ({ error: true }));
        if (probe.hasResend || net.sendCodeSuccess || probe.indicators?.length) break;
      }
      console.log(`[test] After Send code: ${JSON.stringify(probe)}`);
      await s.screenshot(`after_send_code_r${retry}`).catch(() => {});

      if (!probe.hasResend && !net.sendCodeSuccess) {
        console.log(`[test] attempt ${retry + 1}: Send code did not advance form. indicators=${probe.indicators?.join(',') || 'none'}`);
        if (probe.indicators?.includes('rate-limit')) { console.log('FAIL: TikTok rate-limited this session'); break; }
        if (probe.indicators?.length) { console.log(`FAIL: captcha detected — ${probe.indicators.join(',')}`); break; }
        continue;
      }
      if (!probe.hasResend && net.sendCodeSuccess) console.log('[test] send_code API succeeded although countdown text did not render — polling inbox anyway');

      // Poll Resend for verification code
      console.log(`[test] Polling email for ${id.email}...`);
      const code = await s.checkEmail(id.email, 'tiktok');
      if (!code || code === 'no code received' || !/^\d{4,8}$/.test(code)) {
        console.log(`[test] attempt ${retry + 1}: no code (${code})`);
        continue;
      }
      console.log(`[test] Got code: ${code}`);

      // Type code char-by-char w/ variable delays
      const codeLoc = s.page.locator('input[placeholder*="digit" i], input[name="code"]').first();
      await humanClickLocator(s.page, codeLoc).catch(() => {});
      for (const ch of code) { await s.page.keyboard.type(ch); await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 140))); }
      // Reconcile React state only after send_code has succeeded.
      if (await pwLoc.count().catch(() => 0)) await syncReactInputValue(pwLoc, password);
      await syncReactInputValue(codeLoc, code);
      await s.page.keyboard.press('Tab').catch(() => {}); await s.wait(1);

      const nextInfo = await s.page.evaluate(`(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => /^\\s*next\\s*$/i.test((b.textContent || '').trim()));
        if (!btn) return { present: false };
        const r = btn.getBoundingClientRect();
        window.__wclick = [];
        document.addEventListener('click', e => {
          const el = e.target;
          const r2 = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
          window.__wclick.push({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40), id: el.id, cls: (el.className || '').toString().slice(0, 60), isTrusted: e.isTrusted, clientX: e.clientX, clientY: e.clientY, targetRect: { x: r2.x, y: r2.y, w: r2.width, h: r2.height } });
        }, true);
        return { present: true, disabled: btn.disabled, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, center: { x: r.x + r.width/2, y: r.y + r.height/2 } };
      })()`).catch((e) => ({ error: e.message }));
      console.log(`[test] Next button: ${JSON.stringify(nextInfo)}`);

      if (nextInfo.disabled === false) {
        const r = await s.click('Next');
        console.log(`[test] s.click('Next') => ${r}`);
        await s.wait(2);
        if (!net.registerVerifySeen && (s.page.url?.() ?? '').includes('/signup/phone-or-email/email')) {
          console.log('[test] Next click produced no register_verify_login request — trying keyboard activation');
          const nextBtn = s.page.getByRole('button', { name: /^\s*Next\s*$/i }).first();
          await nextBtn.focus().catch(() => {});
          await s.page.keyboard.press('Enter').catch(() => {});
          await s.wait(2);
          if (!net.registerVerifySeen) { await s.page.keyboard.press('Space').catch(() => {}); await s.wait(2); }
          if (!net.registerVerifySeen && await nextBtn.isVisible().catch(() => false)) {
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

      // Wait for URL change OR post-submit state.
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

      if (postUrl.includes('/signup/phone-or-email/email')) {
        console.log(`[test] attempt ${retry + 1}: stuck on signup page — Next didn't create account`);
        continue;
      }

      // Username creation step (extracted to helper)
      const pageText = await s.page.evaluate('document.body.innerText').catch(() => '');
      const nowOnUsernameStep = /\/signup\/create-username/.test(postUrl) ||
                                /create.{0,3}username|choose.{0,3}username|set.{0,3}username/i.test(pageText);
      if (nowOnUsernameStep) {
        id.username = await runUsernameStep(s, id, humanClickLocator);
      }

      // Success: anywhere post-signup that looks logged-in
      const finalUrl = s.page.url?.() ?? '';
      const hasSessionId = await s.page.evaluate('document.cookie.includes("sessionid")').catch(() => false);
      const signedIn = hasSessionId || /foryou|\/@|\/home|onboarding|interests|create-username/.test(finalUrl);
      if (signedIn) {
        await s.saveAccount('tiktok', { username: id.username, email: id.email, password });
        await autoBindCharacter(id.username, 'tiktok').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
        console.log(`PASS: ${id.username} (final url ${finalUrl}, sessionid=${hasSessionId})`);
        success = true;
        break;
      }
      console.log(`[test] attempt ${retry + 1}: didn't reach logged-in state. finalUrl=${finalUrl} sessionid=${hasSessionId}`);
    } catch (e) {
      console.log(`[test] attempt ${retry + 1} crashed: ${e.message?.slice(0, 120)}`);
    }
  }

  if (s) await s.close().catch(() => {});
  if (!success) { console.log('FAIL: exhausted retries'); process.exit(1); }
}
