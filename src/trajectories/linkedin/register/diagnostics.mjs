/**
 * Evidence one submit boundary of the LinkedIn signup run leaves on disk: the
 * shape of the request and of the response, the on-page state of the form, and
 * the redaction that keeps credentials, e-mail addresses and session tokens out
 * of every record written from here. A reading that fails is recorded with
 * its cause, never as an empty, hidden or absent value.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

const SENSITIVE_KEYS =
  /^(password|passwd|pwd|passcode|secret|token|csrf|csrfToken|loginCsrfParam|email|emailAddress|mail|phone|username|firstName|lastName|first-name|last-name|session_key|session_password)$/i;

const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|x-li-track|csrf-token|x-csrf-token|x-restli-protocol-version)$/i;

const EMAIL = /[A-Z\d._%+-]+@[A-Z\d.-]+\.[A-Z][A-Z]+/gi;

const SENSITIVE_ASSIGNMENT =
  /((?:password|passwd|pwd|passcode|secret|token|csrf|csrfToken|loginCsrfParam|email|emailAddress|mail|phone|username|firstName|lastName|first-name|last-name|session_key|session_password)[\]"']?\s*[:=]\s*)["']?([^&;,\s"'}]+)["']?/gi;

/** The written record's indentation. */
const INDENT = '  ';

/** The SHA-256 of an identity string, so runs can be matched without it. */
export function hashValue(value) {
  if (typeof value !== 'string' || value === '') return null;
  return createHash('sha256').update(value).digest('hex');
}

/** The message of a thrown value, redacted. */
function cause(error) {
  return redactDiagnosticText(error instanceof Error ? error.message : String(error));
}

/** A reading that failed, carrying why. */
function failed(error) {
  return { error: cause(error) };
}

/** `text` parsed as JSON, or why it is not JSON. */
function parsedJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return failed(error);
  }
}

function scrubbed(value) {
  if (Array.isArray(value)) return value.map(scrubbed);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => {
        if (!SENSITIVE_KEYS.test(key)) return [key, scrubbed(inner)];
        return [key, key.toLowerCase().includes('email') ? '<redacted-email>' : '<redacted>'];
      }),
    );
  }
  return value;
}

export function redactDiagnosticText(text) {
  if (typeof text !== 'string') return text;
  const parsed = parsedJson(text);
  if ('value' in parsed) return JSON.stringify(scrubbed(parsed.value));
  return text.replace(EMAIL, '<redacted-email>').replace(SENSITIVE_ASSIGNMENT, '$1"<redacted>"');
}

export function summarizeHeaders(headers) {
  const entries = Object.entries(headers);
  return {
    names: entries.map(([name]) => name),
    values: Object.fromEntries(
      entries.map(([name, value]) => [
        name,
        SENSITIVE_HEADER.test(name) ? '<redacted>' : redactDiagnosticText(String(value)),
      ]),
    ),
  };
}

function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array:${value.length}`;
  if (typeof value === 'string') return `string:${value.length}`;
  if (typeof value === 'object') return `object:${Object.keys(value).length}`;
  return typeof value;
}

/** A request body's shape; `postData` is null when the request sent none. */
function summarizePostData(postData) {
  if (postData === null) return { present: false };
  const parsed = parsedJson(postData);
  const object =
    'value' in parsed &&
    parsed.value !== null &&
    typeof parsed.value === 'object' &&
    !Array.isArray(parsed.value);
  return {
    present: true,
    length: postData.length,
    json: object
      ? {
          keys: Object.keys(parsed.value),
          shape: Object.fromEntries(
            Object.entries(parsed.value).map(([key, value]) => [key, shapeOf(value)]),
          ),
        }
      : { not_an_object: 'error' in parsed ? parsed.error : shapeOf(parsed.value) },
    markers: {
      has_apfc: /\bapfc\b/.test(postData),
      has_recaptcha: /recaptcha/i.test(postData),
      has_email: /email/i.test(postData),
      has_password: /password/i.test(postData),
    },
    redacted: redactDiagnosticText(postData),
  };
}

/** A Playwright request's shape, or null when there was no request. */
export function summarizeRequest(req) {
  if (req === null) return null;
  const headers = summarizeHeaders(req.headers());
  let post;
  try {
    post = { value: summarizePostData(req.postData()) };
  } catch (error) {
    post = failed(error);
  }
  return {
    method: req.method(),
    url: req.url(),
    resource_type: req.resourceType(),
    header_names: headers.names,
    headers_redacted: headers.values,
    post_data: post,
  };
}

/** The shape of a response body that was read. */
function bodyRead(bodyText) {
  const parsed = parsedJson(bodyText);
  if ('error' in parsed) return { text_redacted: redactDiagnosticText(bodyText), not_json: parsed.error };
  const keys =
    parsed.value !== null && typeof parsed.value === 'object'
      ? { json_keys: Object.keys(parsed.value) }
      : { json_shape: shapeOf(parsed.value) };
  return { text_redacted: redactDiagnosticText(bodyText), ...keys };
}

/**
 * A Playwright response's shape with the body `bodyText` read from it, or
 * the `bodyReadError` that stopped the body being read (null when it was
 * read); null when there was no response.
 */
export function summarizeResponse(res, bodyText, bodyReadError) {
  if (res === null) return null;
  const headers = summarizeHeaders(res.headers());
  return {
    status: res.status(),
    url: res.url(),
    header_names: headers.names,
    headers_redacted: headers.values,
    body: bodyReadError === null ? bodyRead(bodyText) : { read_error: cause(bodyReadError) },
  };
}

/** What `read` answers, or the redacted reason it could not answer. */
async function probed(read) {
  try {
    return { value: await read() };
  } catch (error) {
    return failed(error);
  }
}

export async function collectSubmitState(page, stage) {
  const present = async (loc) => Boolean(await loc.count());
  const text = (loc) =>
    probed(async () =>
      (await present(loc))
        ? redactDiagnosticText((await loc.innerText()).replace(/\s+/g, ' ').trim())
        : { absent: true },
    );
  const attr = (loc, name) =>
    probed(async () => ((await present(loc)) ? await loc.getAttribute(name) : { absent: true }));
  const visible = (loc) => probed(() => loc.isVisible());
  const count = (loc) => probed(() => loc.count());
  const button = page.locator('button[type="submit"], button#join-form-submit').first();
  const email = page
    .locator('input[name="email-address"], input#email-address, input[type="email"]')
    .first();
  const password = page
    .locator('input[name="password"], input#password, input[type="password"]')
    .first();
  const first = page.locator('input[name="first-name"], input#first-name').first();
  const last = page.locator('input[name="last-name"], input#last-name').first();
  return {
    stage,
    url: page.url(),
    submit_button: {
      visible: await visible(button),
      enabled: await probed(async () =>
        (await present(button)) ? await button.isEnabled() : { absent: true },
      ),
      text: await text(button),
      disabled_attr: await attr(button, 'disabled'),
      aria_disabled: await attr(button, 'aria-disabled'),
    },
    fields: {
      email: {
        visible: await visible(email),
        disabled: await attr(email, 'disabled'),
        aria_invalid: await attr(email, 'aria-invalid'),
      },
      password: {
        visible: await visible(password),
        disabled: await attr(password, 'disabled'),
        aria_invalid: await attr(password, 'aria-invalid'),
      },
      first: { visible: await visible(first), count: await count(first) },
      last: { visible: await visible(last), count: await count(last) },
    },
    alert_text: await text(
      page
        .locator('[role="alert"], .join-form__form-body-error, .alert, .error, [class*="error"]')
        .first(),
    ),
    body_text_sample: await text(page.locator('body').first()),
  };
}

export async function writeSubmitDiagnostics(label, payload) {
  const dir = runRecordingsDir('linkedin_register');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${label}.json`), JSON.stringify(payload, null, INDENT));
}
