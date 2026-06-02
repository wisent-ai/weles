/**
 * LinkedIn signup on dedicated ISP proxies.
 *
 * This trajectory does not attempt to solve or bypass CAPTCHA/checkpoint
 * challenges. It records those states as detection failures so operators do
 * not get false PASS signals from blocked registrations.
 */
import { WSession } from '../../dist/session/wsession.js';
import { humanFill, humanType } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { confirmLinkedinEmail } from './_shared/linkedin/checkpoint.mjs';
import { assertLinkedinAuthenticatedRegistration, assertLinkedinDedicatedIspProxy, assertLinkedinProxyStable, assertLinkedinRegisterProxyRequest, assertNoLinkedinChallengePage, classifyLinkedinRegisterFailure, ensureLinkedinSignupForm, getLinkedinFailureDiagnostics, linkedinRegisterExitCode } from './_shared/linkedin/register_guard.mjs';
import { fillPostRegisterOnboarding } from './_shared/linkedin/onboarding/work_school.mjs';
// generateIdentity import removed — identity now created by WSession.start via opts.platform.

const SIGNUP_URL = 'https://www.linkedin.com/signup';
const DEFAULT_ENTRY_URL = SIGNUP_URL;

import { autoBindCharacter } from './lib/character-bind.mjs';

function hashValue(value) {
  if (typeof value !== 'string' || !value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function loadProxyPreflightSummary() {
  try {
    const p = join(process.cwd(), 'recordings', 'linkedin_register', 'proxy_preflight.json');
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const attempts = Array.isArray(raw?.attempts) ? raw.attempts : [];
    const countBy = (key) => attempts.reduce((acc, a) => {
      const value = a?.[key] ?? 'missing';
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    }, {});
    return {
      selected: raw?.selected === true,
      selected_provider: raw?.selected_provider ?? null,
      failure_reason: raw?.failure_reason ?? null,
      attempt_count: raw?.attempt_count ?? attempts.length,
      linkedin_probe_results: countBy('linkedin_probe_result'),
      rejected_reasons: countBy('rejected_reason'),
      exit_ip_hashes: [...new Set(attempts.map(a => a?.exit_ip_hash).filter(Boolean))],
      redacted: true,
    };
  } catch {
    return null;
  }
}

function redactDiagnosticText(text) {
  if (typeof text !== 'string') return text;
  const sensitiveKeys = /^(password|passwd|pwd|passcode|secret|token|csrf|csrfToken|loginCsrfParam|email|emailAddress|mail|phone|username|session_key|session_password)$/i;
  try {
    const parsed = JSON.parse(text);
    const scrub = (value) => {
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [
          k,
          sensitiveKeys.test(k) ? (String(k).toLowerCase().includes('email') ? '<redacted-email>' : '<redacted>') : scrub(v),
        ]));
      }
      return value;
    };
    return JSON.stringify(scrub(parsed));
  } catch {}
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>')
    .replace(/((?:password|passwd|pwd|passcode|secret|token|csrf|csrfToken|loginCsrfParam|email|emailAddress|mail|phone|username|session_key|session_password)[\]"']?\s*[:=]\s*)["']?([^&;,\s"'}]+)["']?/gi, '$1"<redacted>"');
}

async function summarizeRequest(req) {
  if (!req) return null;
  let postData = '';
  try { postData = req.postData() ?? ''; } catch {}
  return {
    method: req.method?.() ?? null,
    url: req.url?.() ?? null,
    resource_type: req.resourceType?.() ?? null,
    header_names: Object.keys(req.headers?.() ?? {}),
    post_data_present: !!postData,
    post_data_redacted: redactDiagnosticText(postData).slice(0, 2000),
  };
}

async function summarizeResponse(res) {
  if (!res) return null;
  let bodyText = '';
  try { bodyText = await res.text(); } catch (e) { bodyText = `<body-read-error:${e.message?.slice(0, 80)}>`; }
  let bodyJsonKeys = null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object') bodyJsonKeys = Object.keys(parsed).slice(0, 40);
  } catch {}
  return {
    status: res.status?.() ?? null,
    url: res.url?.() ?? null,
    header_names: Object.keys(res.headers?.() ?? {}),
    body_json_keys: bodyJsonKeys,
    body_text_redacted: redactDiagnosticText(bodyText).slice(0, 2000),
  };
}

async function collectSubmitState(page, stage) {
  const safeText = async (loc, max = 500) => {
    try { return redactDiagnosticText((await loc.innerText({ timeout: 1000 })).replace(/\s+/g, ' ').trim()).slice(0, max); } catch { return ''; }
  };
  const safeAttr = async (loc, name) => {
    try { return await loc.getAttribute(name, { timeout: 1000 }); } catch { return null; }
  };
  const button = page.locator('button[type="submit"], button#join-form-submit').first();
  const email = page.locator('input[name="email-address"], input#email-address, input[type="email"]').first();
  const password = page.locator('input[name="password"], input#password, input[type="password"]').first();
  const first = page.locator('input[name="first-name"], input#first-name').first();
  const last = page.locator('input[name="last-name"], input#last-name').first();
  const alertText = await safeText(page.locator('[role="alert"], .join-form__form-body-error, .alert, .error, [class*="error"]').first(), 800);
  const visibleText = await safeText(page.locator('body').first(), 1200);
  return {
    stage,
    url: page.url(),
    submit_button: {
      visible: await button.isVisible({ timeout: 1000 }).catch(() => false),
      enabled: await button.isEnabled({ timeout: 1000 }).catch(() => false),
      text: await safeText(button, 200),
      disabled_attr: await safeAttr(button, 'disabled'),
      aria_disabled: await safeAttr(button, 'aria-disabled'),
    },
    fields: {
      email: { visible: await email.isVisible({ timeout: 1000 }).catch(() => false), disabled: await safeAttr(email, 'disabled'), aria_invalid: await safeAttr(email, 'aria-invalid') },
      password: { visible: await password.isVisible({ timeout: 1000 }).catch(() => false), disabled: await safeAttr(password, 'disabled'), aria_invalid: await safeAttr(password, 'aria-invalid') },
      first: { visible: await first.isVisible({ timeout: 1000 }).catch(() => false), count: await first.count().catch(() => 0) },
      last: { visible: await last.isVisible({ timeout: 1000 }).catch(() => false), count: await last.count().catch(() => 0) },
    },
    alert_text: alertText,
    body_text_sample: visibleText,
  };
}

async function writeSubmitDiagnostics(label, payload) {
  const dir = join(process.cwd(), 'recordings', 'linkedin_register');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${label}.json`), JSON.stringify(payload, null, 2));
}

async function enterLinkedinSignup(session, entryUrl) {
  const entry = String(entryUrl || DEFAULT_ENTRY_URL);
  if (/trk=cold_join_sign_in/i.test(entry)) {
    throw new Error('bad_entry_path: refusing trk=cold_join_sign_in');
  }
  try {
    const u = new URL(entry);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) throw new Error(`non-linkedin host: ${u.hostname}`);
  } catch (e) {
    throw new Error(`bad_entry_path: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  const direct = entry.replace(/\/$/, '') === SIGNUP_URL;
  const diagnostics = {
    mode: direct ? 'direct_signup' : 'entry_chain',
    entry_url: entry,
    signup_url: SIGNUP_URL,
    transitions: [],
  };
  const record = async (stage) => {
    diagnostics.transitions.push(await session.page.evaluate((s) => ({
      stage: s,
      url: location.href,
      title: document.title,
      referrer: document.referrer,
      signup_links: Array.from(document.querySelectorAll('a[href*="/signup"], a[href*="/join"]')).slice(0, 20).map((a) => ({
        text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        href: a.href,
        trk: a.getAttribute('data-tracking-control-name') || new URL(a.href, location.href).searchParams.get('trk') || '',
        visible: !!(a.offsetWidth || a.offsetHeight || a.getClientRects().length),
      })),
      signup_affordances: Array.from(document.querySelectorAll('a, button')).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        href: el instanceof HTMLAnchorElement ? el.href : '',
        trk: el.getAttribute('data-tracking-control-name') || '',
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      })).filter((el) => /^(sign up|join now)$/i.test(el.text)).slice(0, 20),
    }), stage).catch((e) => ({ stage, error: String(e?.message ?? e).slice(0, 200), url: session.page.url() })));
  };

  if (direct) {
    await session.goto(SIGNUP_URL);
    await record('after_direct_signup');
    await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
    return diagnostics;
  }

  await session.runStep('goto_entry', async () => {
    await session.page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    return `entry ${session.page.url()}`;
  });
  await humanIdlePause('deliberate');
  await record('after_entry');

  const explicitSelector = process.env.LINKEDIN_REGISTER_ENTRY_CLICK_SELECTOR || '';
  const clickCandidates = explicitSelector
    ? [session.page.locator(explicitSelector).filter({ visible: true }).first()]
    : [
        session.page.getByRole('link', { name: /^Join now$/i }).first(),
        session.page.getByRole('button', { name: /^Join now$/i }).first(),
        session.page.getByRole('link', { name: /^Sign up$/i }).first(),
        session.page.getByRole('button', { name: /^Sign up$/i }).first(),
      ];
  let clicked = false;
  let clickError = '';
  let clickedAffordance = null;
  for (const loc of clickCandidates) {
    try {
      if (await loc.count() && await loc.isVisible({ timeout: 1500 })) {
        clickedAffordance = await loc.evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          href: el instanceof HTMLAnchorElement ? el.href : '',
          trk: el.getAttribute('data-tracking-control-name') || '',
        })).catch(() => null);
        await humanClickLocator(session.page, loc);
        clicked = true;
        break;
      }
    } catch (e) {
      clickError = String(e?.message ?? e).slice(0, 200);
    }
  }
  diagnostics.clicked_signup_link = clicked;
  diagnostics.clicked_signup_affordance = clickedAffordance;
  diagnostics.click_error = clickError;
  if (!clicked) {
    if (process.env.LINKEDIN_REGISTER_ALLOW_ENTRY_FALLBACK === '1') {
      await session.page.evaluate((url) => { window.location.assign(url); }, SIGNUP_URL).catch(() => {});
      diagnostics.location_assign_fallback = true;
    } else {
      await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
      throw new Error(`entry_path_no_signup_click: ${session.page.url().slice(0, 180)}`);
    }
  }
  await session.page.waitForURL(/\/signup(?:$|[/?#])/, { timeout: 20_000 }).catch(() => {});
  await humanIdlePause('deliberate');
  await record('after_signup_transition');
  await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
  return diagnostics;
}

async function saveVerifiedLinkedinAccount(session, account) {
  const result = await session.saveAccount('linkedin', account);
  if (!String(result).startsWith('account saved:')) {
    throw new Error(`ACCOUNT_PERSIST_FAILED: ${String(result).slice(0, 180)}`);
  }
  return result;
}

async function hasVisibleCaptchaChallenge(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' &&
        s.visibility !== 'hidden' &&
        Number(s.opacity || 1) > 0 &&
        r.width > 0 &&
        r.height > 0;
    };
    const activeCaptchaIframe = Array.from(document.querySelectorAll('iframe')).some((f) => {
      const src = f.src || '';
      const title = f.title || '';
      if (/\/checkpoint\/challengeIframe|challengeIframe/i.test(src)) return visible(f);
      if (/recaptcha/i.test(src) || /recaptcha/i.test(title)) {
        try {
          const u = new URL(src);
          if (/\/recaptcha\/enterprise\/anchor/.test(u.pathname) && u.searchParams.get('size') === 'invisible') return false;
        } catch {}
        return visible(f) && f.getBoundingClientRect().height > 120;
      }
      return false;
    });
    const activeCaptchaDiv = Array.from(document.querySelectorAll('div.g-recaptcha[data-sitekey], .challenge-dialog, #challenge-dialog')).some((el) => {
      if (!visible(el)) return false;
      if (el.classList?.contains('grecaptcha-badge')) return false;
      return true;
    });
    return activeCaptchaIframe || activeCaptchaDiv || /complete (the )?(captcha|security verification)/i.test(document.body?.innerText ?? '');
  }).catch(() => false);
}

async function waitPastEmailVerification(page) {
  for (let i = 0; i < 30; i++) {
    if (!/verify|email-verification|email_verification|checkpoint/.test(page.url())) return;
    await humanIdlePause('deliberate');
  }
}

// Persona + identity + browser + OS + input rotation all centralized in
// WSession.start (platform: 'linkedin'). No browser/OS/input pin — rolls
// naturally like the keeper does.
const requestedProxy = process.env.LINKEDIN_REGISTER_PROXY ?? process.env.LINKEDIN_PROXY ?? process.env.PROXY_URL ?? 'isp decodo us';
const requestedEntryUrl = process.env.LINKEDIN_REGISTER_ENTRY_URL ?? DEFAULT_ENTRY_URL;
const stopAfterSignupReady = process.env.LINKEDIN_REGISTER_STOP_AFTER_SIGNUP_READY === '1';
console.log(`[register] proxy request: ${requestedProxy.startsWith('http') ? '[url-form]' : requestedProxy}`);
console.log(`[register] entry url: ${requestedEntryUrl}`);
let s = null;
let id = { first: '', last: '', handle: '', email: '', password: '' };
let expectedExitIp = '';
let authState = null;

try {
  assertLinkedinRegisterProxyRequest(requestedProxy);
  s = await WSession.start({
    label: 'linkedin_register',
    proxy: requestedProxy,
    targetHost: 'www.linkedin.com',
    platform: 'linkedin',
    browser: process.env.WELES_REGISTER_BROWSER || undefined,
    os: process.env.WELES_REGISTER_OS || undefined,
  });
  id = { first: s.identity.firstName, last: s.identity.lastName, handle: s.identity.username, email: s.identity.email, password: s.identity.password };
  expectedExitIp = s.proxyConfig?.exit_ip ?? '';
  console.log(`[register] identity generated email_hash=${hashValue(id.email)} handle_hash=${hashValue(id.handle)}`);
  assertLinkedinDedicatedIspProxy(s, requestedProxy);
  await enterLinkedinSignup(s, requestedEntryUrl);
  await humanIdlePause('deliberate');
  expectedExitIp = await assertLinkedinProxyStable(s, 'after_goto', expectedExitIp);
  await assertNoLinkedinChallengePage(s, 'after_goto');
  const { emailLoc, pwdLoc } = await ensureLinkedinSignupForm(s);
  if (stopAfterSignupReady) {
    await writeSubmitDiagnostics('stop_after_signup_ready', {
      url: s.page.url(),
      entry_url: requestedEntryUrl,
      expected_exit_ip: expectedExitIp,
      state: await collectSubmitState(s.page, 'stop_after_signup_ready'),
    });
    console.log('DRY_RUN: stop_after_signup_ready');
    process.exitCode = 0;
  } else {
  await humanFill(s.page, emailLoc, id.email);
  await humanFill(s.page, pwdLoc, id.password);
  console.log(`[register] fill email+pwd: ok`);
  expectedExitIp = await assertLinkedinProxyStable(s, 'before_submit_email_password', expectedExitIp);

  const submit1Before = await collectSubmitState(s.page, 'before_submit_email_password');
  const submit1ReqPromise = s.page.waitForRequest((r) => /\/signup\/api\//.test(r.url()), { timeout: 8000 }).catch(() => null);
  const submit1ResPromise = s.page.waitForResponse((r) => /\/signup\/api\//.test(r.url()), { timeout: 8000 }).catch(() => null);
  const submit1 = await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Agree"), button[type="submit"]:has-text("Continue"), button#join-form-submit, button[data-tracking-control-name*="signup"]').first()).then(() => true).catch(e => { console.log(`[register] submit1 err: ${e.message?.slice(0, 80)}`); return false; });
  console.log(`[register] click Agree & Join: ${submit1}`);
  if (!submit1) throw new Error('Agree & Join button not clickable');
  await humanIdlePause('deliberate');
  const [submit1Req, submit1Res] = await Promise.all([submit1ReqPromise, submit1ResPromise]);
  const submit1After = await collectSubmitState(s.page, 'after_submit_email_password');
  const submit1Diagnostics = {
    request: await summarizeRequest(submit1Req),
    response: await summarizeResponse(submit1Res),
    before: submit1Before,
    after: submit1After,
  };
  await writeSubmitDiagnostics('submit1_diagnostics', submit1Diagnostics);
  console.log(`[register] submit1 api=${submit1Diagnostics.request?.method ?? 'none'} status=${submit1Diagnostics.response?.status ?? 'none'} url=${submit1Diagnostics.response?.url ?? submit1Diagnostics.request?.url ?? 'none'}`);
  await assertNoLinkedinChallengePage(s, 'after_submit_email_password');

  const hasV2 = await hasVisibleCaptchaChallenge(s.page);
  if (hasV2) throw new Error('DETECTION_TRIGGERED: visible CAPTCHA challenge after email/password submit');

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
    expectedExitIp = await assertLinkedinProxyStable(s, 'before_create_account', expectedExitIp);
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
      throw new Error(`DETECTION_TRIGGERED: createAccount challengeUrl=${challengeUrl.slice(0, 120)}`);
    }
    await humanIdlePause('long');
    await assertNoLinkedinChallengePage(s, 'after_create_account');
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
  const verifyUrl = s.page.url();
  console.log(`[register] post-name URL: ${verifyUrl}`);
  // Reject /signup as success — silent reCAPTCHA-score rejection looks identical.
  expectedExitIp = await assertLinkedinProxyStable(s, 'before_success_validation', expectedExitIp);
  if (/^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(verifyUrl) || verifyUrl.includes('/signup/api/')) {
    throw new Error(`signup_did_not_complete: URL stayed at ${verifyUrl} — LinkedIn did not accept the registration`);
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
    await waitPastEmailVerification(s.page);
    authState = await assertLinkedinAuthenticatedRegistration(s, 'after_email_verification');
  } else {
    authState = await assertLinkedinAuthenticatedRegistration(s, 'after_registration_redirect');
  }
  // Fill "add a role/school" onboarding gate so stooge can view other profiles.
  try { const ob = await fillPostRegisterOnboarding(s.page); console.log(`[register] onboarding: ${JSON.stringify(ob)}`); } catch (obErr) { console.log(`[register] onboarding err: ${obErr.message?.slice(0, 100)}`); }
  await assertNoLinkedinChallengePage(s, 'after_onboarding');
  authState = await assertLinkedinAuthenticatedRegistration(s, 'after_onboarding');
  expectedExitIp = await assertLinkedinProxyStable(s, 'before_account_persist', expectedExitIp);
  await saveVerifiedLinkedinAccount(s, { username: id.handle, email: id.email, password: id.password, name: `${id.first} ${id.last}` });
  await confirmLinkedinEmail(s.page, id.email).catch((e) => console.log(`[linkedin_register] email confirm err: ${e.message?.slice(0, 80)}`));
  await autoBindCharacter(id.handle, 'linkedin').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
  console.log(`PASS: ${id.handle}`);
  const diagnostics = await getLinkedinFailureDiagnostics(s, requestedProxy, expectedExitIp);
  try { mkdirSync(join(process.cwd(), 'recordings', 'linkedin_register'), { recursive: true }); writeFileSync(join(process.cwd(), 'recordings', 'linkedin_register', 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: 'healthy', healthy: true, details: { username_hash: hashValue(id.handle), email_hash: hashValue(id.email), final_url: s.page.url(), auth: authState, diagnostics }, ts: new Date().toISOString() }, null, 2)); } catch {}
  }
} catch (e) {
  const finalUrl = s?.page?.url?.() ?? '';
  const sig = classifyLinkedinRegisterFailure(e.message ?? '', finalUrl);
  const proxyPreflight = loadProxyPreflightSummary();
  const diagnostics = s ? await getLinkedinFailureDiagnostics(s, requestedProxy, expectedExitIp).catch(() => null) : { proxy: { requested: requestedProxy.startsWith('http') ? '[url-form]' : requestedProxy.slice(0, 80), preflight: proxyPreflight } };
  try { mkdirSync(join(process.cwd(), 'recordings', 'linkedin_register'), { recursive: true }); writeFileSync(join(process.cwd(), 'recordings', 'linkedin_register', 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: sig, healthy: false, details: { final_url: finalUrl, error: e.message?.slice(0, 200), attempted_email_hash: hashValue(id.email), expected_exit_ip: expectedExitIp, diagnostics }, ts: new Date().toISOString() }, null, 2)); } catch {}
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  // exitCode (not exit) so the finally block's await s.close() actually runs.
  // process.exit(1) kills pending async ops immediately, which prevents
  // Playwright from flushing the recordVideo .webm to disk.
  process.exitCode = linkedinRegisterExitCode(sig);
} finally {
  await s?.close?.();
}
