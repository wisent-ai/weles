/**
 * Every way this run learns that LinkedIn caught it — the proxy preflight
 * verdict it inherited, the challenge page it was handed, the CAPTCHA still
 * standing on screen — plus the vocabulary those blocks are reported under.
 * The run never solves a challenge; it names it and stops.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { writeSubmitDiagnostics } from './diagnostics.mjs';

export function loadProxyPreflightSummary() {
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

export async function inspectCreateAccountChallenge(session, challengeUrl) {
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
    await session.page.goto(absoluteUrl, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
    Object.assign(out, await session.page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const attr = (el, name) => {
        const raw = el?.getAttribute(name);
        return typeof raw === 'string' ? raw : null;
      };
      return {
        navigated: true,
        url: location.href,
        title: document.title,
        page_key: attr(document.querySelector('meta[name="pageKey"]'), 'content'),
        body_text_sample: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
        inputs: Array.from(document.querySelectorAll('input')).map((input) => ({
          id: input.id,
          name: input.name,
          type: input.type,
          autocomplete: attr(input, 'autocomplete'),
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

export async function hasVisibleCaptchaChallenge(page) {
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

function addReason(reasons, code, message, data = {}) {
  if (reasons.some((r) => r.code === code)) return;
  reasons.push({ code, message: String(message ?? '').slice(0, 240), ...data });
}

export function linkedinFailureReasons(signal, errorMessage = '', finalUrl = '', diagnostics = null) {
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
  if (/entry_path_no_signup_transition/.test(errorMessage)) {
    addReason(reasons, 'entry_path_no_signup_transition', errorMessage);
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
