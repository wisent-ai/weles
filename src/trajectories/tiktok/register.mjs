import { pageSettled } from '../_shared/page/settled.mjs';
import { WSession } from '../../../dist/session/wsession.js';
import { generatePersona } from '../../../dist/browser/persona.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { generateIdentity } from '../../../dist/utils/identity/identity.js';
import { autoBindCharacter } from '../lib/character-bind.mjs';
import { syncReactInputValue, installNetworkLogger, runUsernameStep } from '../lib/tiktok-register-helpers.mjs';
import { screenshotIfPossible } from '../_shared/runner/evidence.mjs';
import { probeButton, recordedClicks } from './register/button_probe.mjs';
import { dumpStuckState } from './register/stuck_diagnostics.mjs';
import { statedCount } from '../_shared/inputs/stated.mjs';

const URL = 'https://www.tiktok.com/signup';
// Indicators of a captcha or a rate limit after "Send code", read from the page.
const PROBE = `(() => { const t = document.body.innerText || ''; const i = []; if (document.querySelector('.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]')) i.push('captcha-container'); if (document.querySelector('iframe[src*="captcha"]')) i.push('captcha-iframe'); if (/drag|puzzle|rotate|slide/i.test(t)) i.push('captcha-text'); if (/too many|attempts|try again later/i.test(t)) i.push('rate-limit'); return { indicators: i, hasResend: /Resend code/i.test(t), url: location.href }; })()`;

{
  // Single deterministic path — phone-or-email → email tab → fill DOB+email+
  // password → send code → poll the inbox → verify code → land on /foryou.
  // MAX_RETRIES attempts, each with a fresh identity, if browser/page dies
  // during early setup; how many is the caller's and is required.
  let id = null, password = null, s = null, success = false;

  /** A key press the page refuses is logged; the step decides what it means. */
  async function press(key) {
    try { await s.page.keyboard.press(key); } catch (e) { console.log(`[test] key ${key} not delivered: ${e.message}`); }
  }

  const maxRetries = statedCount('MAX_RETRIES', 'how many fresh identities this registration may try');
  // retry-allowed: every attempt registers a different identity through a
  // different sticky proxy exit; a dead page or a TTP2-routed exit is not a
  // verdict on the flow, and MAX_RETRIES is the operator's own bound.
  for (let retry = 0; retry < maxRetries; retry++) {
    if (s) { await s.close().catch((e) => console.log(`[test] close: ${e.message}`)); s = null; }

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

      for (const u of ['https://www.tiktok.com/','https://www.tiktok.com/explore']) { await s.page.goto(u,{waitUntil:'domcontentloaded'}).catch((e) => console.log(`[test] warm-up ${u}: ${e.message}`)); await pageSettled(s.page); }
      await s.goto(URL); await pageSettled(s.page);

      // Verify page is alive
      const alive = await s.page.evaluate('document.querySelector("body") !== null').catch(() => false);
      if (!alive) { console.log(`[test] attempt ${retry + 1}: page died after goto`); continue; }
      // Browser-time vregion check. HTTP preflight verifies the FIRST exit
      // IP; BrightData rotates exits within a sticky. SIGI_STATE pins mssdk
      // routing — TTP2 = click handler bails. Abort + reroll.
      const vregion = await s.page.evaluate(`(() => { const m = (document.body.innerHTML || '').match(/"vregion":"([A-Z0-9-]{1,20})"/); return m ? m[1] : false; })()`).catch(() => false);
      console.log(`[test] attempt ${retry + 1}: browser-time vregion=${vregion}`);
      if (vregion && /-TTP2$/i.test(vregion)) { console.log(`[test] attempt ${retry + 1}: vregion=${vregion} — aborting + rerolling sticky`); continue; }

      // Dismiss cookie banner if EU/UK proxy
      for (const sel of ['button:has-text("Decline optional cookies")', 'button:has-text("Accept all")', 'button:has-text("Allow all")']) {
        try {
          const btn = s.page.locator(sel).first();
          if (await btn.isVisible().catch(() => false)) { await humanClickLocator(s.page, btn); console.log(`[test] Dismissed cookie banner`); break; }
        } catch {}
      }

      // Click "Use phone or email" until the page is on /phone-or-email, then
      // "Sign up with email" until it is on the email tab; the page's own URL
      // ends each, not a count of clicks.
      while (!(s.page.url?.() ?? '').includes('/phone-or-email')) {
        await s.click('Use phone or email');
        await pageSettled(s.page);
      }
      while (!(s.page.url?.() ?? '').includes('/email')) {
        await s.click('Sign up with email');
        await pageSettled(s.page);
      }

      // Select birthday
      await s.select('month', id.birthMonth);
      await s.select('day', id.birthDay);
      await s.select('year', id.birthYear);
      await pageSettled(s.page);

      // Email — humanFill via s.fill works for plain text inputs.
      await s.fill('Email', id.email);
      // Password — TikTok's input has a show/hide eye toggle inside the
      // bounding box (~52px from the right). humanClickLocator's randomized
      // in-element offset can hit the toggle, leaving the focused element
      // detached. So: focus() the input directly (no pointer click), then
      // dispatch keystrokes via humanType.
      const pwLoc = s.page.locator('input[placeholder="Password"], input[type="password"]').first();
      if (await pwLoc.count()) {
        await pwLoc.focus();
        await pageSettled(s.page);
        await press('ControlOrMeta+A');
        await press('Delete');
        await humanType(s.page, password);
      }
      await pageSettled(s.page);
      // Tab out of password — fires React onBlur, dismisses error banner
      await press('Tab');
      await pageSettled(s.page);
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
      await pageSettled(s.page);

      // Capture Send code button rect + install click listener
      const sendInfo = await probeButton(s.page, 'send-code');
      console.log(`[test] send button: ${JSON.stringify(sendInfo)}`);
      if (sendInfo.disabled === false) {
        const r = await s.click('Send code');
        console.log(`[test] s.click('Send code') => ${r}`);
      } else {
        console.log('[test] Send button disabled — skipping');
        continue;
      }
      // Captcha SDK init + invisible-challenge solve run before /send_code/
      // fires; the page is read until the "Resend code" countdown, the
      // send_code response, or a captcha/rate-limit indicator appears.
      let probe = { hasResend: false, indicators: [] };
      while (!(probe.hasResend || net.sendCodeSuccess || probe.indicators?.length)) {
        await pageSettled(s.page);
        probe = await s.page.evaluate(PROBE);
      }
      console.log(`[test] After Send code: ${JSON.stringify(probe)}`);
      await screenshotIfPossible(s, `after_send_code_r${retry}`);

      if (!probe.hasResend && !net.sendCodeSuccess) {
        console.log(`[test] attempt ${retry + 1}: Send code did not advance form. indicators=${probe.indicators?.join(',') || 'none'}`);
        if (probe.indicators?.includes('rate-limit')) { console.log('FAIL: TikTok rate-limited this session'); break; }
        if (probe.indicators?.length) { console.log(`FAIL: captcha detected — ${probe.indicators.join(',')}`); break; }
        if (process.env.STAY_OPEN_ON_STUCK === '1') {
          console.log('[test] STAY_OPEN_ON_STUCK=1 — keeping browser open. Close window manually when done.');
          await humanIdlePause('long');
        }
        await dumpStuckState(s, 'send_code_no_advance');
        continue;
      }
      if (!probe.hasResend && net.sendCodeSuccess) console.log('[test] send_code API succeeded although countdown text did not render — polling inbox anyway');

      // Poll the inbox for the verification code
      console.log(`[test] Polling email for ${id.email}...`);
      const code = await s.checkEmail(id.email, 'tiktok');
      if (!code || code === 'no code received' || !/^\d{4,8}$/.test(code)) {
        console.log(`[test] attempt ${retry + 1}: no code (${code})`);
        continue;
      }
      console.log(`[test] Got code: ${code}`);

      // Type code char-by-char w/ variable delays
      const codeLoc = s.page.locator('input[placeholder*="digit" i], input[name="code"]').first();
      await humanClickLocator(s.page, codeLoc).catch((e) => console.log(`[test] code input click: ${e.message}`));
      await humanType(s.page, code);
      // Reconcile React state only after send_code has succeeded.
      if (await pwLoc.count().catch(() => false)) await syncReactInputValue(pwLoc, password);
      await syncReactInputValue(codeLoc, code);
      await press('Tab'); await pageSettled(s.page);

      const nextInfo = await probeButton(s.page, 'next');
      console.log(`[test] Next button: ${JSON.stringify(nextInfo)}`);

      if (nextInfo.disabled === false) {
        const r = await s.click('Next');
        console.log(`[test] s.click('Next') => ${r}`);
        await pageSettled(s.page);
        if (!net.registerVerifySeen && (s.page.url?.() ?? '').includes('/signup/phone-or-email/email')) {
          console.log('[test] Next click produced no register_verify_login request — trying keyboard activation');
          const nextBtn = s.page.getByRole('button', { name: /^\s*Next\s*$/i }).first();
          await nextBtn.focus().catch((e) => console.log(`[test] Next focus: ${e.message}`));
          await press('Enter');
          await pageSettled(s.page);
          if (!net.registerVerifySeen) { await press('Space'); await pageSettled(s.page); }
          if (!net.registerVerifySeen && await nextBtn.isVisible().catch(() => false)) {
            await humanClickLocator(s.page, nextBtn).catch((e) => console.log(`[test] Next click: ${e.message}`));
            await pageSettled(s.page);
          }
        }
      } else {
        console.log('[test] Next disabled, cannot submit');
        continue;
      }
      await pageSettled(s.page);

      console.log(`[test] clicks received: ${await recordedClicks(s.page)}`);

      // Wait for URL change OR post-submit state; the page is read until one
      // of them shows.
      let postUrl = s.page.url?.() ?? '';
      for (;;) {
        await pageSettled(s.page);
        postUrl = s.page.url?.() ?? '';
        const t = await s.page.evaluate('(document.body.innerText || "").toLowerCase()');
        if (/create-username|foryou|\/@|onboarding|interests|choose.*username|create a username|profile picture|turn on notifications/i.test(postUrl + ' ' + t)) {
          console.log(`[test] post-next state found: url=${postUrl}`); break;
        }
        if (/drag|puzzle|captcha|verify/i.test(t)) { console.log(`[test] captcha-like: ${t}`); break; }
        if (/incorrect|invalid|attempts reached|try again later|account.*already/i.test(t)) { console.log(`[test] error: ${t}`); break; }
      }
      await screenshotIfPossible(s, `after_next_r${retry}`);

      if (postUrl.includes('/signup/phone-or-email/email')) {
        console.log(`[test] attempt ${retry + 1}: stuck on signup page — Next didn't create account`);
        await dumpStuckState(s, 'next_no_account');
        continue;
      }

      // Username creation step (extracted to helper)
      const pageText = await s.page.evaluate('document.body.innerText');
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
        await autoBindCharacter(id.username, 'tiktok').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message}`));
        console.log(`PASS: ${id.username} (final url ${finalUrl}, sessionid=${hasSessionId})`);
        success = true;
        break;
      }
      console.log(`[test] attempt ${retry + 1}: didn't reach logged-in state. finalUrl=${finalUrl} sessionid=${hasSessionId}`);
    } catch (e) {
      console.log(`[test] attempt ${retry + 1} crashed: ${e.message}`);
    }
  }

  if (s) await s.close().catch((e) => console.log(`[test] close: ${e.message}`));
  if (!success) { console.log('FAIL: exhausted retries'); process.exitCode = 1; }
}
