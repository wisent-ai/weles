/**
 * LinkedIn signup with reCAPTCHA Enterprise v3 pre-solving. Linkedin's signup
 * flow uses INVISIBLE reCAPTCHA Enterprise v3 — no challenge popup, just
 * background scoring on the form-submit endpoint. The classic solve_captcha
 * agent tool only handles visible challenges; v3 needs explicit token
 * injection BEFORE each form submit.
 */
import { WSession } from '../../dist/session/wsession.js';
import { CaptchaSolver } from '../../dist/captcha/solver.js';
import { execute } from '../../dist/agent/loop.js';
import { humanFill } from '../../dist/human/keyboard.js';
import { humanClickLocator } from '../../dist/human/mouse.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const URL = 'https://www.linkedin.com/signup';
const RECAPTCHA_SITEKEY = '6LcIy_MqAAAAAMKiupFSbmzW3xjGSlIfRzNWYMjC';
const AGENT_DOMAIN = process.env.AGENT_DOMAIN;
if (!AGENT_DOMAIN) { console.log('FAIL: AGENT_DOMAIN env not set'); process.exit(1); }

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
  // LinkedIn's V2 checkbox modal uses a DIFFERENT sitekey than the V3 invisible
  // tracker. Extract the V2 sitekey from the recaptcha iframe URL: it has
  // pattern /recaptcha/(api2|enterprise)/anchor?ar=1&k=<SITEKEY>&...
  // Fall back to V3 sitekey only if extraction fails.
  let v2Sitekey = RECAPTCHA_SITEKEY;
  for (const f of page.frames()) {
    const m = (f.url() || '').match(/[?&]k=([0-9A-Za-z_-]+)/);
    if (m && m[1] !== RECAPTCHA_SITEKEY) { v2Sitekey = m[1]; break; }
  }
  console.log(`[recaptcha:v2] using sitekey=${v2Sitekey.slice(0, 20)}...`);
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

function genIdentity() {
  const F = 'Garry,Katie,Logan,Maya,Owen,Riley,Sage,Tess,Wes,Zane'.split(',');
  const L = 'Koepp,Bayer,Pratt,Quinn,Reeves,Stone,Vega,West,Yates,Cole'.split(',');
  const first = F[Math.floor(Math.random() * F.length)];
  const last = L[Math.floor(Math.random() * L.length)];
  const handle = `${first.toLowerCase()}${last.toLowerCase()}${Math.floor(Math.random() * 9000 + 1000)}`;
  const password = randomBytes(9).toString('base64').replace(/[+/=]/g, '') + '!A1';
  const email = `${handle}@${AGENT_DOMAIN}`;
  return { first, last, handle, email, password };
}

const id = genIdentity();
console.log(`[register] identity: ${id.email} / ${id.first} ${id.last}`);

const s = await WSession.start({ label: 'linkedin_register', proxy: process.env.PROXY_URL || 'residential', targetHost: 'www.linkedin.com' });
try {
  await s.goto(URL);
  await s.page.waitForTimeout(2500);

  // Humanized fill — bare descriptor.set + dispatch('input') previously
  // bypassed all keystrokes, which LinkedIn's reCAPTCHA Enterprise v3 saw as
  // a bot signal even with a valid token.
  const emailLoc = s.page.locator('input[name="email-address"], input[autocomplete="email"], input#email-address').filter({ visible: true }).first();
  const pwdLoc = s.page.locator('input[name="password"], input[autocomplete="new-password"], input#password').filter({ visible: true }).first();
  const hasEmail = await emailLoc.count();
  const hasPwd = await pwdLoc.count();
  if (!hasEmail || !hasPwd) throw new Error(`email/password fields not found (hasEmail=${hasEmail} hasPwd=${hasPwd})`);
  await humanFill(s.page, emailLoc, id.email);
  await humanFill(s.page, pwdLoc, id.password);
  console.log(`[register] fill email+pwd: ok`);

  await getAndInjectRecaptcha(s.page, 'signup');
  await s.page.waitForTimeout(500);

  const submit1 = await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Agree"), button[type="submit"]:has-text("Continue"), button#join-form-submit, button[data-tracking-control-name*="signup"]').first()).then(() => true).catch(e => { console.log(`[register] submit1 err: ${e.message?.slice(0, 80)}`); return false; });
  console.log(`[register] click Agree & Join: ${submit1}`);
  if (!submit1) throw new Error('Agree & Join button not clickable');
  await s.page.waitForTimeout(4000);

  // After Agree & Join, LinkedIn often presents a v2 "I'm not a robot" modal.
  // Detect it and solve via API token (v2 solver's frame chain doesn't match
  // LinkedIn's challengeIframe wrapper, so we inject directly).
  const hasV2 = await s.page.evaluate(() => !!document.querySelector('iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"], div.g-recaptcha[data-sitekey]') || Array.from(document.querySelectorAll('iframe')).some(f => /challengeIframe/.test(f.src ?? '')));
  if (hasV2) {
    console.log('[register] v2 modal detected — solving via API token');
    const v2ok = await solveV2Modal(s.page);
    if (v2ok) {
      await s.page.waitForTimeout(2000);
      const v2submit = await humanClickLocator(s.page, s.page.locator('button:has-text("Verify"), button:has-text("Continue"), button:has-text("Submit"), button[type="submit"]').last()).then(() => true).catch(() => false);
      console.log(`[register] v2 submit: ${v2submit}`);
      await s.page.waitForTimeout(4000);
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
    await s.page.waitForTimeout(500);
    const submit2 = await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Continue"), button#join-form-submit').first()).then(() => true).catch(e => { console.log(`[register] submit2 err: ${e.message?.slice(0, 80)}`); return false; });
    console.log(`[register] click Continue: ${submit2}`);
    if (!submit2) throw new Error('Continue button not clickable');
    await s.page.waitForTimeout(5000);
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
    await s.page.waitForTimeout(2000);
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
  // No flowName — each register run has a unique identity, so flow cache
  // would replay save_account with stale args. Re-plan every run.
  // Also reject /signup as a "success" — it means signup didn't actually
  // complete (silent reCAPTCHA score rejection).
  if (/^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(verifyUrl) || verifyUrl.includes('/signup/api/')) {
    throw new Error(`signup_did_not_complete: URL stayed at ${verifyUrl} — likely reCAPTCHA score too low or silent rejection`);
  }
  if (/verify|email-verification|email_verification|checkpoint/.test(verifyUrl)) {
    const result = await execute(s, `On LinkedIn email verification page. check_email(email=${id.email},sender="linkedin") to retrieve the 6-digit verification code. fill(target="verification code field, pin input, or 6-digit code", value=<code>). Click Submit/Verify/Continue. Wait for redirect. save_account(platform="linkedin",username=${id.handle},email=${id.email},password=${id.password},name="${id.first} ${id.last}"). done(value=${id.handle}).`);
    console.log(`PASS: ${result.value}`);
  } else {
    const result = await execute(s, `LinkedIn signup completed at URL ${verifyUrl}. save_account(platform="linkedin",username=${id.handle},email=${id.email},password=${id.password},name="${id.first} ${id.last}"). done(value=${id.handle}).`);
    console.log(`PASS: ${result.value}`);
  }
  try { mkdirSync(join(process.cwd(), 'recordings', 'linkedin_register'), { recursive: true }); writeFileSync(join(process.cwd(), 'recordings', 'linkedin_register', 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: 'healthy', healthy: true, details: { username: id.handle, email: id.email, final_url: s.page.url() }, ts: new Date().toISOString() }, null, 2)); } catch {}
} catch (e) {
  const finalUrl = s.page.url?.() ?? '';
  let sig = 'action_failed';
  if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
  else if (/captcha|challenge|checkpoint/.test(finalUrl)) sig = 'captcha_challenge';
  try { mkdirSync(join(process.cwd(), 'recordings', 'linkedin_register'), { recursive: true }); writeFileSync(join(process.cwd(), 'recordings', 'linkedin_register', 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: sig, healthy: false, details: { final_url: finalUrl, error: e.message?.slice(0, 200), attempted_email: id.email }, ts: new Date().toISOString() }, null, 2)); } catch {}
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close();
}
