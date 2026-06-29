/**
 * LinkedIn signup on dedicated ISP proxies.
 *
 * This trajectory does not attempt to solve or bypass CAPTCHA/checkpoint
 * challenges. It records those states as detection failures so operators do
 * not get false PASS signals from blocked registrations.
 */
import { WSession } from '../../dist/session/wsession.js';
import { humanFill, humanType } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause, humanScroll } from '../../dist/human/mouse.js';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { confirmLinkedinEmail } from './_shared/linkedin/checkpoint.mjs';
import { handleCreateAccountChallenge } from './_shared/linkedin/create_account_challenge.mjs';
import { assertLinkedinAuthenticatedRegistration, assertLinkedinDedicatedIspProxy, assertLinkedinProxyStable, assertLinkedinRegisterProxyRequest, assertNoLinkedinChallengePage, classifyLinkedinRegisterFailure, ensureLinkedinSignupForm, getLinkedinFailureDiagnostics, linkedinRegisterExitCode } from './_shared/linkedin/register_guard.mjs';
import { fillPostRegisterOnboarding } from './_shared/linkedin/onboarding/work_school.mjs';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../dist/diagnostics/fingerprint_probe.js';
import { analyze, pickBaseline } from '../../dist/diagnostics/fingerprint_analyzer.js';
// generateIdentity import removed — identity now created by WSession.start via opts.platform.

const SIGNUP_URL = 'https://www.linkedin.com/signup';
const DEFAULT_ENTRY_URL = SIGNUP_URL;
// Default lowered to 10 so known persistent tells (e.g. screen.availTop,
// WebRTC local-IP leak) trigger an early quit instead of burning an account
// on LinkedIn. Operators can raise it once those signals are clean.
const EARLY_FP_RISK_THRESHOLD = Number(process.env.WELES_EARLY_FP_RISK ?? 10);

async function earlyFingerprintCheck(s) {
  if (process.env.WELES_EARLY_FP === '0') return null;
  const dir = runRecordingsDir('linkedin_register');
  mkdirSync(dir, { recursive: true });
  try {
    await s.goto('about:blank');
    const js = await s.page.evaluate(FP_SCRIPT);
    await s.page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const raw = await s.page.evaluate(`document.body.innerText || document.body.textContent || ''`);
    const network = parseNetworkFingerprint(raw);
    const payload = { capturedAt: new Date().toISOString(), source: 'weles-early', browser: s._browserProvenance?.browser ?? 'unknown', js, network };
    const baselineDir = process.env.WELES_BASELINE_DIR || join(process.cwd(), 'recordings', 'baselines');
    let baseline;
    let baselinePath;
    if (existsSync(baselineDir)) {
      ({ path: baselinePath, data: baseline } = pickBaseline(baselineDir, payload));
    } else {
      baseline = {};
      baselinePath = '';
    }
    const report = analyze(payload, baseline);
    report.meta.subjectPath = join(dir, 'early_fingerprint.json');
    report.meta.baselinePath = baselinePath;
    writeFileSync(report.meta.subjectPath, JSON.stringify(payload, null, 2));
    writeFileSync(join(dir, 'early_detection_report.json'), JSON.stringify(report, null, 2));
    console.log(`[register] early fingerprint risk=${report.summary.riskScore} critical=${report.summary.critical} baselineMatched=${report.meta.baselineMatched}`);
    if (report.summary.riskScore >= EARLY_FP_RISK_THRESHOLD || report.summary.critical > 0) {
      throw new Error(`FINGERPRINT_INCONSISTENT: early risk=${report.summary.riskScore} critical=${report.summary.critical} findings=${report.findings.map(f => f.id).join(',')}`);
    }
    return report;
  } catch (e) {
    if (String(e.message ?? e).startsWith('FINGERPRINT_INCONSISTENT')) throw e;
    console.log(`[register] early fingerprint check skipped: ${String(e).slice(0, 120)}`);
    return null;
  }
}

import { autoBindCharacter } from './lib/character-bind.mjs';
import { runRecordingsDir } from '../../dist/session/run-recordings.js';

function hashValue(value) {
  if (typeof value !== 'string' || !value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function loadProxyPreflightSummary() {
  try {
    const p = join(runRecordingsDir('linkedin_register'), 'proxy_preflight.json');
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
  const sensitiveKeys = /^(password|passwd|pwd|passcode|secret|token|csrf|csrfToken|loginCsrfParam|email|emailAddress|mail|phone|username|firstName|lastName|first-name|last-name|session_key|session_password)$/i;
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
    .replace(/((?:password|passwd|pwd|passcode|secret|token|csrf|csrfToken|loginCsrfParam|email|emailAddress|mail|phone|username|firstName|lastName|first-name|last-name|session_key|session_password)[\]"']?\s*[:=]\s*)["']?([^&;,\s"'}]+)["']?/gi, '$1"<redacted>"');
}

function summarizeHeaders(headers = {}) {
  const sensitiveHeader = /^(authorization|cookie|set-cookie|x-li-track|csrf-token|x-csrf-token|x-restli-protocol-version)$/i;
  const entries = Object.entries(headers ?? {});
  return {
    names: entries.map(([name]) => name),
    values: Object.fromEntries(entries.map(([name, value]) => [
      name,
      sensitiveHeader.test(name) ? '<redacted>' : redactDiagnosticText(String(value)).slice(0, 500),
    ])),
  };
}

function summarizePostData(postData = '') {
  if (!postData) {
    return {
      present: false,
      length: 0,
      json_keys: null,
      json_shape: null,
      markers: {},
      redacted: '',
      redacted_truncated: false,
    };
  }
  const summary = {
    present: true,
    length: postData.length,
    json_keys: null,
    json_shape: null,
    markers: {
      has_apfc: /\bapfc\b/.test(postData),
      has_recaptcha: /recaptcha|g-recaptcha|captchaResponse/i.test(postData),
      has_email: /emailAddress|email-address|email/i.test(postData),
      has_password: /password/i.test(postData),
    },
    redacted: '',
    redacted_truncated: false,
  };
  try {
    const parsed = JSON.parse(postData);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      summary.json_keys = Object.keys(parsed);
      summary.json_shape = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
        if (value === null) return [key, 'null'];
        if (Array.isArray(value)) return [key, `array:${value.length}`];
        if (typeof value === 'string') return [key, `string:${value.length}`];
        if (typeof value === 'object') return [key, `object:${Object.keys(value).length}`];
        return [key, typeof value];
      }));
    }
  } catch {}
  const redacted = redactDiagnosticText(postData);
  const max = 20_000;
  summary.redacted = redacted.slice(0, max);
  summary.redacted_truncated = redacted.length > max;
  return summary;
}

async function summarizeRequest(req) {
  if (!req) return null;
  let postData = '';
  try { postData = req.postData() ?? ''; } catch {}
  const headers = summarizeHeaders(req.headers?.() ?? {});
  const post = summarizePostData(postData);
  return {
    method: req.method?.() ?? null,
    url: req.url?.() ?? null,
    resource_type: req.resourceType?.() ?? null,
    header_names: headers.names,
    headers_redacted: headers.values,
    post_data_present: post.present,
    post_data_length: post.length,
    post_data_json_keys: post.json_keys,
    post_data_json_shape: post.json_shape,
    post_data_markers: post.markers,
    post_data_redacted: post.redacted,
    post_data_redacted_truncated: post.redacted_truncated,
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
  const headers = summarizeHeaders(res.headers?.() ?? {});
  return {
    status: res.status?.() ?? null,
    url: res.url?.() ?? null,
    header_names: headers.names,
    headers_redacted: headers.values,
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
  const dir = runRecordingsDir('linkedin_register');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${label}.json`), JSON.stringify(payload, null, 2));
}

async function inspectCreateAccountChallenge(session, challengeUrl) {
  const absoluteUrl = new URL(challengeUrl, 'https://www.linkedin.com/').toString();
  const out = {
    challenge_url: absoluteUrl,
    navigated: false,
    url: '',
    title: '',
    page_key: '',
    body_text_sample: '',
    inputs: [],
    buttons: [],
    iframes: [],
    kind: 'challenge',
  };
  try {
    await session.page.goto(absoluteUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await humanIdlePause('deliberate');
    Object.assign(out, await session.page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      return {
        navigated: true,
        url: location.href,
        title: document.title,
        page_key: document.querySelector('meta[name="pageKey"]')?.getAttribute('content') || '',
        body_text_sample: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
        inputs: Array.from(document.querySelectorAll('input')).map((input) => ({
          id: input.id,
          name: input.name,
          type: input.type,
          autocomplete: input.getAttribute('autocomplete') || '',
          visible: visible(input),
        })).slice(0, 30),
        buttons: Array.from(document.querySelectorAll('button,a')).filter(visible).map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          href: el instanceof HTMLAnchorElement ? el.href : '',
        })).slice(0, 30),
        iframes: Array.from(document.querySelectorAll('iframe')).map((frame) => ({
          id: frame.id,
          name: frame.name,
          title: frame.title,
          src: frame.src,
          visible: visible(frame),
          width: frame.getBoundingClientRect().width,
          height: frame.getBoundingClientRect().height,
        })).slice(0, 30),
      };
    }));
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 500);
    out.url = session.page.url?.() ?? '';
  }
  const haystack = [
    out.challenge_url,
    out.url,
    out.title,
    out.page_key,
    out.body_text_sample,
    ...(out.inputs || []).flatMap((i) => [i.id, i.name, i.type, i.autocomplete]),
    ...(out.buttons || []).flatMap((b) => [b.text, b.href]),
    ...(out.iframes || []).flatMap((f) => [f.id, f.name, f.title, f.src]),
  ].join(' ');
  if (/Phone Verification|phone verification|verify (your )?phone|phone number|verification code|one-time code/i.test(haystack)) {
    out.kind = 'phone_verification';
  } else if (/Security verification|quick security check|captcha|recaptcha|arkose|funcaptcha|verify you are human|unusual activity/i.test(haystack)) {
    out.kind = 'captcha_gauntlet';
  } else if (/checkpoint|challengeIframe|challenge/i.test(haystack)) {
    out.kind = 'checkpoint_challenge';
  }
  await writeSubmitDiagnostics('create_account_challenge_diagnostics', out);
  return out;
}

function parseLinkedinUrlList(value = '') {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new URL(s, 'https://www.linkedin.com/').toString())
    .filter((url) => /(^|\.)linkedin\.com$/i.test(new URL(url).hostname));
}

async function prewarmLinkedinGuestSession(session, urls) {
  if (!urls.length) return null;
  const diagnostics = {
    urls,
    transitions: [],
  };
  for (const url of urls) {
    try {
      await session.runStep(`prewarm_${diagnostics.transitions.length}`, async () => {
        await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return `prewarm ${session.page.url()}`;
      });
      // Fast scroll to generate behavioral signal without spending human-like time
      // on a cold guest session. The goal is cookie/telemetry warm-up, not realism.
      await session.scroll('down', 400).catch(() => {});
      await humanIdlePause('deliberate');
    } catch (prewarmErr) {
      console.log(`[register] prewarm skip ${url}: ${prewarmErr.message?.slice(0, 120)}`);
      diagnostics.transitions.push({ url, stage: 'prewarm_error', error: String(prewarmErr?.message ?? prewarmErr).slice(0, 200) });
      continue;
    }
    diagnostics.transitions.push(await session.page.evaluate(() => ({
      url: location.href,
      title: document.title,
      referrer: document.referrer,
      cookie_count: document.cookie ? document.cookie.split(';').filter(Boolean).length : 0,
      page_key: document.querySelector('meta[name="pageKey"]')?.getAttribute('content') || '',
      authwall: /\/authwall/.test(location.href),
      visible_text_sample: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    })).catch((e) => ({ url: session.page.url(), error: String(e?.message ?? e).slice(0, 200) })));
  }
  await writeSubmitDiagnostics('guest_prewarm_diagnostics', diagnostics);
  return diagnostics;
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
    try {
      await session.runStep('goto_signup', async () => {
        await session.page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return `signup ${session.page.url()}`;
      });
    } catch (e) {
      const formVisible = await session.page
        .locator('input[name="email-address"], input#email-address, input[type="email"]')
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      if (!formVisible) throw e;
      diagnostics.direct_signup_goto_timeout_form_visible = true;
      diagnostics.direct_signup_goto_timeout_error = String(e?.message ?? e).slice(0, 300);
      console.log('[register] signup goto timed out, but signup form is visible — continuing');
    }
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
const HEADLESS = process.env.HEADLESS === '1' || process.env.WELES_HEADLESS === '1' || process.env.LINKEDIN_REGISTER_HEADLESS === '1';
const stopAfterSignupReady = process.env.LINKEDIN_REGISTER_STOP_AFTER_SIGNUP_READY === '1';
const envPrewarmUrls = parseLinkedinUrlList(process.env.LINKEDIN_REGISTER_PREWARM_URLS ?? '');
const defaultPrewarmUrls = process.env.LINKEDIN_REGISTER_DEFAULT_PREWARM === '1' && envPrewarmUrls.length === 0
  ? ['https://www.linkedin.com/', 'https://www.linkedin.com/signup']
  : [];
const guestPrewarmUrls = [...envPrewarmUrls, ...defaultPrewarmUrls];
const warmProfileDir = process.env.LINKEDIN_REGISTER_WARM_PROFILE_DIR || process.env.WELES_USER_DATA_DIR || '';
function loadWarmManifest(dir = '') {
  if (!dir) return null;
  try {
    const p = join(dir, 'warm_manifest.json');
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (raw?.schema !== 'linkedin_register_warm_profile.v1') return null;
    return raw;
  } catch {
    return null;
  }
}
const warmManifest = loadWarmManifest(warmProfileDir);
const replayProxyUrl = warmManifest?.proxy_replay?.url || '';
const sessionProxy = replayProxyUrl || requestedProxy;
const registerBrowser = process.env.WELES_REGISTER_BROWSER || warmManifest?.persona?.browser || (warmProfileDir ? 'chromium' : undefined);
const registerOs = process.env.WELES_REGISTER_OS || warmManifest?.persona?.os || (warmProfileDir ? 'windows' : undefined);
const registerPersona = warmManifest?.persona || undefined;
function safeRequestedProxy(value = '') {
  const raw = String(value ?? '');
  return /^(https?:|socks)/i.test(raw) ? '[url-form]' : raw.slice(0, 80);
}

const stageEvents = [];
function proxyStageState() {
  const cfg = s?.proxyConfig ?? {};
  return {
    expected_exit_ip: expectedExitIp || '',
    actual_exit_ip: cfg.exit_ip ?? '',
    proxy_type: cfg.proxy_type ?? '',
    provider: cfg.provider ?? '',
    country: cfg.country ?? '',
    platform: cfg.platform ?? '',
  };
}

function recordStage(stage, data = {}) {
  stageEvents.push({
    ts: new Date().toISOString(),
    stage,
    url: s?.page?.url?.() ?? '',
    ...proxyStageState(),
    ...data,
  });
}

function addReason(reasons, code, message, data = {}) {
  if (reasons.some((r) => r.code === code)) return;
  reasons.push({ code, message: String(message ?? '').slice(0, 240), ...data });
}

function linkedinFailureReasons(signal, errorMessage = '', finalUrl = '', diagnostics = null) {
  const reasons = [];
  if (/PROXY_NOT_DEDICATED_ISP/.test(errorMessage)) {
    addReason(reasons, 'proxy_not_dedicated_isp', errorMessage);
  }
  if (/PROXY_DRIFT_CHECK_FAILED/.test(errorMessage)) {
    addReason(reasons, 'proxy_drift_probe_failed', errorMessage);
  }
  if (/PROXY_DRIFT:/.test(errorMessage)) {
    addReason(reasons, 'proxy_exit_ip_drift', errorMessage);
  }
  if (/DETECTION_TRIGGERED/.test(errorMessage) || signal === 'captcha_challenge') {
    addReason(reasons, 'linkedin_challenge_or_checkpoint', errorMessage || finalUrl);
  }
  if (/PHONE_VERIFICATION_REQUIRED/.test(errorMessage) || signal === 'phone_verification_required') {
    addReason(reasons, 'phone_verification_required', errorMessage || finalUrl);
  }
  if (/signup_form_unavailable/.test(errorMessage)) {
    addReason(reasons, 'signup_form_unavailable', errorMessage);
  }
  if (/entry_path_no_signup_click/.test(errorMessage)) {
    addReason(reasons, 'entry_path_no_signup_click', errorMessage);
  }
  if (/signup_did_not_complete/.test(errorMessage) || /^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(finalUrl)) {
    addReason(reasons, 'signup_did_not_complete', errorMessage || finalUrl);
  }
  if (/signup_verification_incomplete/.test(errorMessage)) {
    addReason(reasons, 'signup_verification_incomplete', errorMessage);
  }
  if (/signup_did_not_authenticate/.test(errorMessage)) {
    addReason(reasons, 'missing_authenticated_session', errorMessage);
  }
  if (/ACCOUNT_PERSIST_FAILED/.test(errorMessage)) {
    addReason(reasons, 'account_persist_failed', errorMessage);
  }
  if (diagnostics?.challenge_signal) {
    addReason(reasons, 'linkedin_page_challenge_signal', diagnostics.challenge_signal);
  }
  if (diagnostics?.auth && diagnostics.auth.has_li_at === false && signal !== 'proxy_failed') {
    addReason(reasons, 'missing_li_at_cookie', `linkedin_cookie_count=${diagnostics.auth.linkedin_cookie_count ?? 'unknown'}`);
  }
  if (!reasons.length) addReason(reasons, signal || 'action_failed', errorMessage || finalUrl || 'unclassified failure');
  return reasons;
}

console.log(`[register] proxy request: ${safeRequestedProxy(requestedProxy)}`);
console.log(`[register] entry url: ${requestedEntryUrl}`);
if (guestPrewarmUrls.length) console.log(`[register] guest prewarm urls: ${guestPrewarmUrls.length}`);
if (warmProfileDir) console.log(`[register] warm profile dir: ${warmProfileDir}`);
if (warmManifest) console.log('[register] warm manifest loaded: persona+proxy replay enabled');
let s = null;
let id = { first: '', last: '', handle: '', email: '', password: '' };
let expectedExitIp = '';
let authState = null;

try {
  recordStage('proxy_request_received', { requested_proxy: safeRequestedProxy(requestedProxy) });
  assertLinkedinRegisterProxyRequest(requestedProxy);
  recordStage('proxy_request_validated', { requested_proxy: safeRequestedProxy(requestedProxy) });
  s = await WSession.start({
    label: 'linkedin_register',
    proxy: sessionProxy,
    targetHost: 'www.linkedin.com',
    platform: 'linkedin',
    browser: registerBrowser,
    os: registerOs,
    persona: registerPersona,
    headless: HEADLESS,
    userDataDir: warmProfileDir || undefined,
  });
  if (warmManifest?.proxy_metadata && s.proxyConfig) {
    Object.assign(s.proxyConfig, Object.fromEntries(Object.entries({
      exit_ip: warmManifest.proxy_metadata.exit_ip,
      provider: warmManifest.proxy_metadata.provider,
      proxy_type: warmManifest.proxy_metadata.proxy_type,
      country: warmManifest.proxy_metadata.country,
      platform: warmManifest.proxy_metadata.platform,
      sticky_session_id: warmManifest.proxy_metadata.sticky_session_id,
      sticky_hash: warmManifest.proxy_metadata.sticky_hash,
      exit_reputation: warmManifest.proxy_metadata.exit_reputation,
    }).filter(([, v]) => v !== null && v !== undefined && v !== '')));
  }
  if (warmManifest) {
    await writeSubmitDiagnostics('warm_manifest_replay', {
      manifest_schema: warmManifest.schema,
      profile_dir: warmManifest.profile_dir,
      persona_replayed: Boolean(registerPersona),
      proxy_replayed: Boolean(replayProxyUrl),
      persona: registerPersona,
      proxy_metadata: warmManifest.proxy_metadata ?? null,
      session_proxy: {
        server: s.proxyConfig?.server ?? null,
        provider: s.proxyConfig?.provider ?? null,
        proxy_type: s.proxyConfig?.proxy_type ?? null,
        country: s.proxyConfig?.country ?? null,
        exit_ip: s.proxyConfig?.exit_ip ?? null,
        sticky_session_id: s.proxyConfig?.sticky_session_id ?? null,
        sticky_hash: s.proxyConfig?.sticky_hash ?? null,
      },
    });
  }
  recordStage('session_started');
  await earlyFingerprintCheck(s);
  recordStage('early_fingerprint_ok');
  id = { first: s.identity.firstName, last: s.identity.lastName, handle: s.identity.username, email: s.identity.email, password: s.identity.password };
  expectedExitIp = s.proxyConfig?.exit_ip ?? '';
  recordStage('identity_ready', { identity_created: true, email_hash: hashValue(id.email), handle_hash: hashValue(id.handle) });
  console.log(`[register] identity generated email_hash=${hashValue(id.email)} handle_hash=${hashValue(id.handle)}`);
  assertLinkedinDedicatedIspProxy(s, requestedProxy);
  recordStage('proxy_metadata_validated');
  const prewarmDiagnostics = await prewarmLinkedinGuestSession(s, guestPrewarmUrls);
  if (prewarmDiagnostics) recordStage('guest_prewarm_complete', { urls: guestPrewarmUrls.length });
  await enterLinkedinSignup(s, requestedEntryUrl);
  recordStage('signup_goto_complete', { entry_url: requestedEntryUrl });
  await humanIdlePause('deliberate');
  expectedExitIp = await assertLinkedinProxyStable(s, 'after_goto', expectedExitIp);
  recordStage('proxy_stable_after_goto');
  await assertNoLinkedinChallengePage(s, 'after_goto');
  recordStage('no_challenge_after_goto');
  const { emailLoc, pwdLoc } = await ensureLinkedinSignupForm(s);
  recordStage('signup_form_ready');
  // Simulate a human reading the signup form before interacting.
  await humanScroll(s.page, 400, 2);
  await humanIdlePause('deliberate');
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
  await humanIdlePause('short');
  await humanFill(s.page, pwdLoc, id.password);
  await humanIdlePause('deliberate');
  recordStage('email_password_filled');
  console.log(`[register] fill email+pwd: ok`);
  expectedExitIp = await assertLinkedinProxyStable(s, 'before_submit_email_password', expectedExitIp);
  recordStage('proxy_stable_before_email_password_submit');

  const submit1Before = await collectSubmitState(s.page, 'before_submit_email_password');
  const submit1ReqPromise = s.page.waitForRequest((r) => /\/signup\/api\//.test(r.url()), { timeout: 8000 }).catch(() => null);
  const submit1ResPromise = s.page.waitForResponse((r) => /\/signup\/api\//.test(r.url()), { timeout: 8000 }).catch(() => null);
  const submit1 = await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Agree"), button[type="submit"]:has-text("Continue"), button#join-form-submit, button[data-tracking-control-name*="signup"]').first()).then(() => true).catch(e => { console.log(`[register] submit1 err: ${e.message?.slice(0, 80)}`); return false; });
  console.log(`[register] click Agree & Join: ${submit1}`);
  if (!submit1) throw new Error('Agree & Join button not clickable');
  recordStage('email_password_submitted', { clicked: submit1 });
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
  recordStage('no_challenge_after_email_password_submit');

  const hasV2 = await hasVisibleCaptchaChallenge(s.page);
  recordStage('captcha_frame_probe', { has_visible_captcha_frame: hasV2 });
  if (hasV2) throw new Error('DETECTION_TRIGGERED: visible CAPTCHA challenge after email/password submit');

  const firstLoc = s.page.locator('input[name="first-name"], input#first-name').filter({ visible: true }).first();
  const lastLoc = s.page.locator('input[name="last-name"], input#last-name').filter({ visible: true }).first();
  const hasFirst = await firstLoc.count();
  const hasLast = await lastLoc.count();
  let fillBOk = false;
  if (hasFirst && hasLast) {
    await humanFill(s.page, firstLoc, id.first);
    await humanIdlePause('short');
    await humanFill(s.page, lastLoc, id.last);
    await humanIdlePause('deliberate');
    fillBOk = true;
    recordStage('first_last_filled');
  } else {
    console.log(`[register] fill first+last skipped (hasFirst=${hasFirst} hasLast=${hasLast} url=${s.page.url()})`);
    recordStage('first_last_skipped', { has_first_input: Boolean(hasFirst), has_last_input: Boolean(hasLast) });
  }
  if (fillBOk) {
    expectedExitIp = await assertLinkedinProxyStable(s, 'before_create_account', expectedExitIp);
    recordStage('proxy_stable_before_create_account');
    const submit2Before = await collectSubmitState(s.page, 'before_create_account');
    // Capture /signup/api/cors/createAccount response BEFORE click. On a
    // challenged session LinkedIn returns HTTP 200 with body
    // {submissionId, challengeUrl:"/checkpoint/challengeIframe/..."} — the
    // challenge lives inside an iframe at challengeUrl, NOT a top-level
    // redirect. Without explicitly navigating to challengeUrl the page stays
    // at /signup forever and the post-redirect loop times out as "rejected".
    // Diff harness 2026-05-06 .work/inst/linkedin_register_2026-05-06T17-59-19-014Z.json
    // captured this exact response shape on the 17:59 run.
    const createAccountReq = s.page.waitForRequest((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20_000 }).catch(() => null);
    const createAccountRes = s.page.waitForResponse((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20_000 }).catch(() => null);
    const submit2 = await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Continue"), button#join-form-submit').first()).then(() => true).catch(e => { console.log(`[register] submit2 err: ${e.message?.slice(0, 80)}`); return false; });
    console.log(`[register] click Continue: ${submit2}`);
    if (!submit2) throw new Error('Continue button not clickable');
    recordStage('create_account_submitted', { clicked: submit2 });
    const [apiReq, apiRes] = await Promise.all([createAccountReq, createAccountRes]);
    let challengeUrl = '';
    let createAccountStatus = null;
    let createAccountBody = null;
    if (apiRes) {
      try {
        createAccountBody = await apiRes.json();
        challengeUrl = createAccountBody?.challengeUrl ?? '';
        createAccountStatus = apiRes.status();
        console.log(`[register] createAccount status=${apiRes.status()} submissionId=${(createAccountBody?.submissionId ?? '').slice(0, 12)} challengeUrl=${challengeUrl ? challengeUrl.slice(0, 60) + '...' : 'none'}`);
      } catch (e) { console.log(`[register] createAccount body parse err: ${e.message?.slice(0, 80)}`); }
    }
    const submit2After = await collectSubmitState(s.page, 'after_create_account');
    await writeSubmitDiagnostics('submit2_diagnostics', {
      request: await summarizeRequest(apiReq),
      response: await summarizeResponse(apiRes),
      before: submit2Before,
      after: submit2After,
      create_account: {
        status: createAccountStatus,
        has_challenge_url: Boolean(challengeUrl),
        challenge_url: challengeUrl ? challengeUrl.slice(0, 200) : '',
        body_keys: createAccountBody && typeof createAccountBody === 'object' ? Object.keys(createAccountBody).slice(0, 40) : null,
      },
    });
    recordStage('create_account_response', { status: createAccountStatus, has_challenge_url: Boolean(challengeUrl) });
    if (challengeUrl) {
      // G19: captcha/challenge means the run is burned. Do not attempt to solve
      // it (that hangs indefinitely and kills the close-time diagnostics). Instead
      // classify the challenge page, record it, and fail fast so the finally block
      // can flush the fingerprint + detection report.
      let challengeKind = 'unknown';
      try {
        const challenge = await inspectCreateAccountChallenge(s, challengeUrl);
        challengeKind = challenge.kind || 'unknown';
        recordStage('create_account_challenge_classified', {
          challenge_kind: challenge.kind,
          challenge_title: challenge.title || '',
          challenge_url: challenge.challenge_url.slice(0, 200),
        });
      } catch {}
      throw new Error(`DETECTION_TRIGGERED: createAccount challenge detected (kind=${challengeKind})`);
    }
    await humanIdlePause('long');
    await assertNoLinkedinChallengePage(s, 'after_create_account');
    recordStage('no_challenge_after_create_account');
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
  recordStage('post_name_url', { verify_url: verifyUrl });
  // Reject /signup as success — silent reCAPTCHA-score rejection looks identical.
  expectedExitIp = await assertLinkedinProxyStable(s, 'before_success_validation', expectedExitIp);
  recordStage('proxy_stable_before_success_validation');
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
    recordStage('email_verification_completed', { authenticated: authState?.has_li_at ?? false });
  } else {
    authState = await assertLinkedinAuthenticatedRegistration(s, 'after_registration_redirect');
    recordStage('registration_redirect_authenticated', { authenticated: authState?.has_li_at ?? false });
  }
  // Fill "add a role/school" onboarding gate so stooge can view other profiles.
  try { const ob = await fillPostRegisterOnboarding(s.page); console.log(`[register] onboarding: ${JSON.stringify(ob)}`); } catch (obErr) { console.log(`[register] onboarding err: ${obErr.message?.slice(0, 100)}`); }
  recordStage('onboarding_attempted');
  await assertNoLinkedinChallengePage(s, 'after_onboarding');
  recordStage('no_challenge_after_onboarding');
  authState = await assertLinkedinAuthenticatedRegistration(s, 'after_onboarding');
  recordStage('after_onboarding_authenticated', { authenticated: authState?.has_li_at ?? false });
  expectedExitIp = await assertLinkedinProxyStable(s, 'before_account_persist', expectedExitIp);
  recordStage('proxy_stable_before_account_persist');
  await saveVerifiedLinkedinAccount(s, { username: id.handle, email: id.email, password: id.password, name: `${id.first} ${id.last}` });
  recordStage('account_persisted');
  await confirmLinkedinEmail(s.page, id.email).catch((e) => console.log(`[linkedin_register] email confirm err: ${e.message?.slice(0, 80)}`));
  await autoBindCharacter(id.handle, 'linkedin').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
  recordStage('pass');
  console.log(`PASS: ${id.handle}`);
  const diagnostics = await getLinkedinFailureDiagnostics(s, requestedProxy, expectedExitIp);
  try { mkdirSync(runRecordingsDir('linkedin_register'), { recursive: true }); writeFileSync(join(runRecordingsDir('linkedin_register'), 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: 'healthy', healthy: true, details: { username_hash: hashValue(id.handle), email_hash: hashValue(id.email), final_url: s.page.url(), auth: authState, diagnostics, failure_reasons: [], stage_events: stageEvents }, ts: new Date().toISOString() }, null, 2)); } catch {}
  }
} catch (e) {
  const finalUrl = s?.page?.url?.() ?? '';
  const errorMessage = e.message ?? '';
  const sig = classifyLinkedinRegisterFailure(errorMessage, finalUrl);
  recordStage('failure_classified', { signal: sig, error: errorMessage.slice(0, 200) });
  const proxyPreflight = loadProxyPreflightSummary();
  const diagnostics = s ? await getLinkedinFailureDiagnostics(s, requestedProxy, expectedExitIp).catch(() => null) : { proxy: { requested: safeRequestedProxy(requestedProxy), preflight: proxyPreflight } };
  const failureReasons = linkedinFailureReasons(sig, errorMessage, finalUrl, diagnostics);
  try { mkdirSync(runRecordingsDir('linkedin_register'), { recursive: true }); writeFileSync(join(runRecordingsDir('linkedin_register'), 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: sig, healthy: false, details: { final_url: finalUrl, error: errorMessage.slice(0, 200), attempted_email_hash: hashValue(id.email), expected_exit_ip: expectedExitIp, diagnostics, failure_reasons: failureReasons, stage_events: stageEvents }, ts: new Date().toISOString() }, null, 2)); } catch {}
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  // exitCode (not exit) so the finally block's await s.close() actually runs.
  // process.exit(1) kills pending async ops immediately, which prevents
  // Playwright from flushing the recordVideo .webm to disk.
  process.exitCode = linkedinRegisterExitCode(sig);
} finally {
  await s?.close?.();
}
