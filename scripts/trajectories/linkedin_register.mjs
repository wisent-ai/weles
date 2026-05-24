/**
 * LinkedIn signup with reCAPTCHA Enterprise v3 pre-solving. Linkedin's signup
 * flow uses INVISIBLE reCAPTCHA Enterprise v3 — no challenge popup, just
 * background scoring on the form-submit endpoint. The classic solve_captcha
 * agent tool only handles visible challenges; v3 needs explicit token
 * injection BEFORE each form submit.
 */
import { WSession } from '../../dist/session/wsession.js';
import { CaptchaSolver } from '../../dist/captcha/solver.js';
import { humanFill, humanType } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { confirmLinkedinEmail, solveLinkedinCheckpoint } from './_shared/linkedin/checkpoint.mjs';
import { fillPostRegisterOnboarding } from './_shared/linkedin/onboarding/work_school.mjs';
// generateIdentity import removed — identity now created by WSession.start via opts.platform.

const URL = 'https://www.linkedin.com/signup';
const RECAPTCHA_SITEKEY = '6LcIy_MqAAAAAMKiupFSbmzW3xjGSlIfRzNWYMjC';

import { autoBindCharacter } from './lib/character-bind.mjs';
import { generateIdentity } from '../../dist/utils/identity.js';

async function getAndInjectRecaptcha(page, action) {
  const solver = new CaptchaSolver();
  const token = await solver.solveRecaptchaV3(RECAPTCHA_SITEKEY, URL, action);
  if (!token) { console.log(`[recaptcha:${action}] v3 solver returned null`); return null; }
  const injected = await page.evaluate((tk) => {
    const fields = Array.from(document.querySelectorAll('textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]'));
    for (const f of fields) {
      const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(f, tk);
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
    }
    window.__weles_recaptcha_token = tk;
    return fields.length;
  }, token);
  console.log(`[recaptcha:v3 ${action}] token=${token.slice(0, 16)}... injected into ${injected} field(s)`);
  return token;
}

async function solveV2Modal(page) {
  // LinkedIn's V2 modal uses a DIFFERENT sitekey from the V3 invisible
  // tracker. Wait up to 8s for the recaptcha bframe to load, then extract
  // sitekey from its URL (pattern /recaptcha/(api2|enterprise)/(anchor|
  // bframe)?...&k=<SITEKEY>) or from the page's [data-sitekey] attribute.
  // Cited 2026-05-05 register-B failure: passing the V3 sitekey to a V2
  // task causes CapMonster INVALID_SITEKEY and CapSolver returns a junk
  // token that LinkedIn silently rejects post-submit.
  // Match only V2 anchor/bframe iframes; V3 also lives at /enterprise/* but never under /anchor|/bframe.
  let v2Sitekey = null;
  for (let i = 0; i < 16; i++) {
    for (const f of page.frames()) {
      const url = f.url() || '';
      if (!/recaptcha\/(api2|enterprise)\/(anchor|bframe)/i.test(url)) continue;
      const m = url.match(/[?&]k=([0-9A-Za-z_-]+)/);
      if (m && m[1] !== RECAPTCHA_SITEKEY) { v2Sitekey = m[1]; break; }
    }
    if (v2Sitekey) break;
    try {
      const dom = await page.evaluate((v3Key) => { for (const el of document.querySelectorAll('[data-sitekey]')) { const k = el.getAttribute('data-sitekey'); if (k && k !== v3Key) return k; } return null; }, RECAPTCHA_SITEKEY);
      if (dom) { v2Sitekey = dom; break; }
    } catch {}
    await humanIdlePause('short');
  }
  if (!v2Sitekey) {
    const allFrames = page.frames().map(f => (f.url() || '').slice(0, 100)).join(' | ');
    console.log(`[recaptcha:v2] could not extract V2 sitekey — frames: ${allFrames.slice(0, 400)}`);
    return false;
  }
  console.log(`[recaptcha:v2] extracted sitekey=${v2Sitekey.slice(0, 20)}...`);
  const solver = new CaptchaSolver();
  const token = await solver.solveRecaptchaV2(page, v2Sitekey, { enterprise: true });
  if (!token || token === false) { console.log('[recaptcha:v2] solver returned null/false'); return false; }
  const tokenStr = typeof token === 'string' ? token : '';
  if (!tokenStr) { console.log('[recaptcha:v2] solver returned non-string'); return false; }
  for (const f of [page.mainFrame(), ...page.frames()]) {
    try {
      const n = await f.evaluate((tk) => {
        const fields = Array.from(document.querySelectorAll('textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"], textarea#g-recaptcha-response'));
        for (const e of fields) {
          const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, tk);
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (typeof window.___grecaptcha_cfg === 'object') { try { Object.values(window.___grecaptcha_cfg.clients ?? {}).forEach(c => { for (const k in c) if (typeof c[k]?.callback === 'function') c[k].callback(tk); }); } catch {} }
        return fields.length;
      }, tokenStr);
      if (n > 0) console.log(`[recaptcha:v2] token injected into ${n} field(s) in frame=${f.url().slice(0, 60)}`);
    } catch { /* frame may have detached */ }
  }
  return true;
}

// Persona + identity rotation centralized in WSession.start (platform: 'linkedin').
// Browser pin to chromium retained: 2026-05-13 instrumented Firefox run hit
// locator timeout 30s on input[name=email-address] — LinkedIn served Firefox a
// different signup page OR the weles Firefox build doesn't render correctly.
// Until firefox-build is patched separately, browser stays chromium. OS still
// rotates via persona (~70% windows / 25% macos / 5% linux).
if (!process.env.PROXY_URL) { console.log('FAIL: PROXY_URL unset — LinkedIn register requires explicit static ISP proxy (isp.oxylabs.io:8003-8010). Random-sticky residential is burned for LinkedIn signup.'); process.exit(2); }
const s = await WSession.start({ label: 'linkedin_register', proxy: process.env.PROXY_URL, targetHost: 'www.linkedin.com', platform: 'linkedin', browser: 'chromium' });
const id = { first: s.identity.firstName, last: s.identity.lastName, handle: s.identity.username, email: s.identity.email, password: s.identity.password };
console.log(`[register] identity: ${id.email} / ${id.first} ${id.last}`);
// Persist credentials so a captcha failure mid-run still leaves a way to log in via keeper.
try { const { writeFileSync: _wf } = await import('node:fs'); _wf('/tmp/linkedin_register_creds.txt', `email=${id.email}\nhandle=${id.handle}\npassword=${id.password}\nfirst=${id.first}\nlast=${id.last}\nproxy=${process.env.PROXY_URL}\nts=${new Date().toISOString()}\n`); }
catch (e) { console.log(`[register] creds file err: ${e.message?.slice(0, 80)}`); }
try {
  await s.goto(URL);
  await humanIdlePause('deliberate');
  // Force autocomplete=off + clear values on every input. 2026-05-11
  // recording showed prior subprocess identities leaking via Chromium autofill.
  await s.page.evaluate(() => { for (const el of document.querySelectorAll('input,textarea')) { el.setAttribute('autocomplete','off'); el.value=''; } }).catch(e => console.log(`[register] autofill-disable err: ${e.message?.slice(0, 80)}`));
  const emailLoc = s.page.locator('input[name="email-address"], input[autocomplete="email"], input#email-address').filter({ visible: true }).first();
  const pwdLoc = s.page.locator('input[name="password"], input[autocomplete="new-password"], input#password').filter({ visible: true }).first();
  const hasEmail = await emailLoc.count();
  const hasPwd = await pwdLoc.count();
  if (!hasEmail || !hasPwd) throw new Error(`email/password fields not found (hasEmail=${hasEmail} hasPwd=${hasPwd})`);
  await humanFill(s.page, emailLoc, id.email);
  await humanFill(s.page, pwdLoc, id.password);
  console.log(`[register] fill email+pwd: ok`);

  await getAndInjectRecaptcha(s.page, 'signup');
  await humanIdlePause('short');

  const submit1 = await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Agree"), button[type="submit"]:has-text("Continue"), button#join-form-submit, button[data-tracking-control-name*="signup"]').first()).then(() => true).catch(e => { console.log(`[register] submit1 err: ${e.message?.slice(0, 80)}`); return false; });
  console.log(`[register] click Agree & Join: ${submit1}`);
  if (!submit1) throw new Error('Agree & Join button not clickable');
  await humanIdlePause('deliberate');

  // After Agree & Join, LinkedIn often presents a v2 "I'm not a robot" modal.
  // Detect it and solve via API token (v2 solver's frame chain doesn't match
  // LinkedIn's challengeIframe wrapper, so we inject directly).
  const hasV2 = await s.page.evaluate(() => !!document.querySelector('iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"], div.g-recaptcha[data-sitekey]') || Array.from(document.querySelectorAll('iframe')).some(f => /challengeIframe/.test(f.src ?? '')));
  if (hasV2) {
    console.log('[register] v2 modal detected — solving via API token');
    const v2ok = await solveV2Modal(s.page);
    if (v2ok) {
      await humanIdlePause('deliberate');
      const v2submit = await humanClickLocator(s.page, s.page.locator('button:has-text("Verify"), button:has-text("Continue"), button:has-text("Submit"), button[type="submit"]').last()).then(() => true).catch(() => false);
      console.log(`[register] v2 submit: ${v2submit}`);
      await humanIdlePause('deliberate');
    }
  }

  const firstLoc = s.page.locator('input[name="first-name"], input#first-name').filter({ visible: true }).first();
  const lastLoc = s.page.locator('input[name="last-name"], input#last-name').filter({ visible: true }).first();
  const hasFirst = await firstLoc.count();
  const hasLast = await lastLoc.count();
  let fillBOk = false;
  if (hasFirst && hasLast) {
    await humanFill(s.page, firstLoc, id.first);
    await humanFill(s.page, lastLoc, id.last);
    fillBOk = true;
  } else {
    console.log(`[register] fill first+last skipped (hasFirst=${hasFirst} hasLast=${hasLast} url=${s.page.url()})`);
  }
  if (fillBOk) {
    await getAndInjectRecaptcha(s.page, 'signup');
    await humanIdlePause('short');
    // Capture /signup/api/cors/createAccount response BEFORE click. On a
    // challenged session LinkedIn returns HTTP 200 with body
    // {submissionId, challengeUrl:"/checkpoint/challengeIframe/..."} — the
    // challenge lives inside an iframe at challengeUrl, NOT a top-level
    // redirect. Without explicitly navigating to challengeUrl the page stays
    // at /signup forever and the post-redirect loop times out as "rejected".
    // Diff harness 2026-05-06 .work/inst/linkedin_register_2026-05-06T17-59-19-014Z.json
    // captured this exact response shape on the 17:59 run.
    const createAccountRes = s.page.waitForResponse((r) => /\/signup\/api\/cors\/createAccount/.test(r.url())).catch(() => null);
    const submit2 = await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Continue"), button#join-form-submit').first()).then(() => true).catch(e => { console.log(`[register] submit2 err: ${e.message?.slice(0, 80)}`); return false; });
    console.log(`[register] click Continue: ${submit2}`);
    if (!submit2) throw new Error('Continue button not clickable');
    const apiRes = await createAccountRes;
    let challengeUrl = '';
    if (apiRes) {
      try {
        const body = await apiRes.json();
        challengeUrl = body?.challengeUrl ?? '';
        console.log(`[register] createAccount status=${apiRes.status()} submissionId=${(body?.submissionId ?? '').slice(0, 12)} challengeUrl=${challengeUrl ? challengeUrl.slice(0, 60) + '...' : 'none'}`);
      } catch (e) { console.log(`[register] createAccount body parse err: ${e.message?.slice(0, 80)}`); }
    }
    if (challengeUrl) {
      // DETECTION_TRIGGERED. createAccount returned challengeUrl → IP or
      // fingerprint is burned. Bail with exit code 2 so batch can rotate.
      if (process.env.LINKEDIN_REGISTER_TRY_CHALLENGE !== '1') {
        console.log(`FAIL: DETECTION_TRIGGERED — createAccount challengeUrl set; rotate IP/fingerprint and retry`);
        process.exit(2);
      }
      const fullUrl = challengeUrl.startsWith('http') ? challengeUrl : `https://www.linkedin.com${challengeUrl}`;
      console.log(`[register] navigating to challenge: ${fullUrl.slice(0, 80)}...`);
      await s.page.goto(fullUrl, { waitUntil: 'domcontentloaded' }).catch(e => console.log(`[register] challenge goto err: ${e.message?.slice(0, 80)}`));
      const captchaReady = await s.page.waitForSelector('iframe[src*="captchaInternal"], iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"]', { state: 'attached' }).then(() => true).catch(() => false);
      console.log(`[register] captcha iframe attached: ${captchaReady}`);
      await humanIdlePause('deliberate');
      const cp = await solveLinkedinCheckpoint({ ctx: s.ctx, page: s.page }, 'register', id.email);
      console.log(`[register] checkpoint solver returned: liAt=${cp?.liAt ? 'yes' : 'no'} finalUrl=${cp?.finalUrl?.slice(0, 80)}`);
    }
    await humanIdlePause('long');
  }

  // Wait for the post-signup redirect to /feed, /onboarding, or /checkpoint.
  // /signup/api/cors/createAccount issues li_at via Set-Cookie on the next
  // navigation; the redirect can take up to ~30s on the first signup. Check
  // for li_at in the cookie jar directly — once it appears, the account is
  // authenticated even if the URL hasn't fully resolved yet.
  for (let i = 0; i < 30; i++) {
    const u = s.page.url();
    const ck = await s.ctx.cookies().catch(() => []);
    const haveLiAt = ck.some(c => c.name === 'li_at' && c.value);
    if (haveLiAt || /\/feed|\/onboarding|\/check|\/m\/welcome/.test(u)) break;
    if (/^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(u)) break; // signup rejected, no point waiting
    await humanIdlePause('deliberate');
  }
  // After redirect settles, persist cookies to social_accounts.metadata.cookies.
  try {
    const cookies = await s.ctx.cookies();
    const linkedinCookies = cookies.filter(c => /linkedin\.com/.test(c.domain ?? ''));
    const liAt = linkedinCookies.find(c => c.name === 'li_at')?.value ?? '';
    console.log(`[register] post-redirect URL=${s.page.url()} cookies=${linkedinCookies.length} li_at=${liAt ? 'yes' : 'no'}`);
    if (liAt) {
      const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
      if (supabaseUrl && supabaseKey) {
        const lookup = await fetch(`${supabaseUrl}/rest/v1/social_accounts?platform=eq.linkedin&username=eq.${id.handle}&select=id,metadata`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } });
        const rows = await lookup.json();
        if (rows[0]) {
          const merged = { ...(rows[0].metadata ?? {}), cookies: linkedinCookies };
          await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${rows[0].id}`, { method: 'PATCH', headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: merged }) });
          console.log(`[register] persisted ${linkedinCookies.length} cookies (incl. li_at) to account ${rows[0].id}`);
        }
      }
    }
  } catch (cookieErr) { console.log(`[register] cookie persist err: ${cookieErr.message?.slice(0, 100)}`); }
  const verifyUrl = s.page.url();
  console.log(`[register] post-name URL: ${verifyUrl}`);
  process.env.LINKEDIN_NEW_EMAIL = id.email;
  process.env.LINKEDIN_NEW_PASSWORD = id.password;
  process.env.LINKEDIN_NEW_FIRSTNAME = id.first;
  process.env.LINKEDIN_NEW_LASTNAME = id.last;
  process.env.LINKEDIN_NEW_USERNAME = id.handle;
  // Reject /signup as success — silent reCAPTCHA-score rejection looks identical.
  if (/^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(verifyUrl) || verifyUrl.includes('/signup/api/')) {
    throw new Error(`signup_did_not_complete: URL stayed at ${verifyUrl} — likely reCAPTCHA score too low or silent rejection`);
  }
  if (/verify|email-verification|email_verification|checkpoint/.test(verifyUrl)) {
    // Email verification: poll Resend for 6-digit code → fill PIN input → submit.
    const code = await s.checkEmail(id.email, 'linkedin');
    if (!code || /^no code|^error:/.test(code)) throw new Error(`linkedin verification email did not arrive: ${code}`);
    const pinIn = s.page.locator('input[name="pin"], input[autocomplete="one-time-code"], input#input__email_verification_pin').filter({ visible: true }).first();
    await pinIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, pinIn);
    await humanType(s.page, code);
    await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Submit"), button:has-text("Verify"), button[type="submit"]:has-text("Agree"), button#email-pin-submit-button').first());
    await s.page.waitForFunction(() => !/verify|email-verification|email_verification|checkpoint/.test(location.href), { timeout: 30000 }).catch(() => {});
    await s.saveAccount('linkedin', { username: id.handle, email: id.email, password: id.password, name: `${id.first} ${id.last}` });
    await confirmLinkedinEmail(s.page, id.email).catch((e) => console.log(`[linkedin_register] email confirm err: ${e.message?.slice(0, 80)}`));
    await autoBindCharacter(id.handle, 'linkedin').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
    console.log(`PASS: ${id.handle}`);
  } else {
    await s.saveAccount('linkedin', { username: id.handle, email: id.email, password: id.password, name: `${id.first} ${id.last}` });
    await confirmLinkedinEmail(s.page, id.email).catch((e) => console.log(`[linkedin_register] email confirm err: ${e.message?.slice(0, 80)}`));
    await autoBindCharacter(id.handle, 'linkedin').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
    console.log(`PASS: ${id.handle}`);
  }
  // Fill "add a role/school" onboarding gate so stooge can view other profiles.
  try { const ob = await fillPostRegisterOnboarding(s.page); console.log(`[register] onboarding: ${JSON.stringify(ob)}`); } catch (obErr) { console.log(`[register] onboarding err: ${obErr.message?.slice(0, 100)}`); }
  try { mkdirSync(join(process.cwd(), 'recordings', 'linkedin_register'), { recursive: true }); writeFileSync(join(process.cwd(), 'recordings', 'linkedin_register', 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: 'healthy', healthy: true, details: { username: id.handle, email: id.email, final_url: s.page.url() }, ts: new Date().toISOString() }, null, 2)); } catch {}
} catch (e) {
  const finalUrl = s.page.url?.() ?? '';
  let sig = 'action_failed';
  if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
  else if (/captcha|challenge|checkpoint/.test(finalUrl)) sig = 'captcha_challenge';
  try { mkdirSync(join(process.cwd(), 'recordings', 'linkedin_register'), { recursive: true }); writeFileSync(join(process.cwd(), 'recordings', 'linkedin_register', 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: sig, healthy: false, details: { final_url: finalUrl, error: e.message?.slice(0, 200), attempted_email: id.email }, ts: new Date().toISOString() }, null, 2)); } catch {}
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  // exitCode (not exit) so the finally block's await s.close() actually runs.
  // process.exit(1) kills pending async ops immediately, which prevents
  // Playwright from flushing the recordVideo .webm to disk.
  process.exitCode = 1;
} finally {
  await s.close();
}
