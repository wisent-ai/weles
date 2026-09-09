/**
 * Evidence one submit boundary of the LinkedIn signup run leaves on disk: the
 * shape of the request and of the response, the on-page state of the form, and
 * the redaction that keeps credentials, e-mail addresses and session tokens out
 * of every record written from here.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

export function hashValue(value) {
  if (typeof value !== 'string' || !value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function redactDiagnosticText(text) {
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

export function summarizeHeaders(headers = {}) {
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

export async function summarizeRequest(req) {
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

export async function summarizeResponse(res) {
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

export async function collectSubmitState(page, stage) {
  const safeText = async (loc, max = 500) => {
    if (!(await loc.count())) return '';
    try { return redactDiagnosticText((await loc.innerText()).replace(/\s+/g, ' ').trim()).slice(0, max); } catch { return ''; }
  };
  const safeAttr = async (loc, name) => {
    if (!(await loc.count())) return null;
    try { return await loc.getAttribute(name); } catch { return null; }
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
      visible: await button.isVisible().catch(() => false),
      enabled: (await button.count()) ? await button.isEnabled().catch(() => false) : false,
      text: await safeText(button, 200),
      disabled_attr: await safeAttr(button, 'disabled'),
      aria_disabled: await safeAttr(button, 'aria-disabled'),
    },
    fields: {
      email: { visible: await email.isVisible().catch(() => false), disabled: await safeAttr(email, 'disabled'), aria_invalid: await safeAttr(email, 'aria-invalid') },
      password: { visible: await password.isVisible().catch(() => false), disabled: await safeAttr(password, 'disabled'), aria_invalid: await safeAttr(password, 'aria-invalid') },
      first: { visible: await first.isVisible().catch(() => false), count: await first.count() },
      last: { visible: await last.isVisible().catch(() => false), count: await last.count() },
    },
    alert_text: alertText,
    body_text_sample: visibleText,
  };
}

export async function writeSubmitDiagnostics(label, payload) {
  const dir = runRecordingsDir('linkedin_register');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${label}.json`), JSON.stringify(payload, null, 2));
}
