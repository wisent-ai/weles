// The page operations a journey needs beyond navigate, read, click and fill:
// reload, viewport, headers, init scripts, routed responses, element state,
// waits, keys, checkboxes, uploads, in-page requests and the events a page
// reported. Every selector is a Playwright selector string, so role, text and
// label engines (role=button[name="Start"], internal:label="Email") work the
// same as CSS.

import { readFileSync } from 'node:fs';
import type { Cookie } from 'playwright';
import { DeclaredError, messageOf } from '../errors/index.cjs';
import { causes } from '../errors/operations/browser.cjs';
import {
  asOptionalNumber,
  asString,
  getBrowser,
  getPage,
  getPageEvents,
  shown,
  textResult,
} from './state.js';

type LoadState = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
type ElementState = 'attached' | 'detached' | 'visible' | 'hidden';

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (value === undefined)
    throw new DeclaredError(causes.ARGUMENT_MISSING, {
      name,
      value: shown(value),
    });
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DeclaredError(causes.ARGUMENT_TYPE, {
      name,
      value: shown(value),
      expected: 'an object of strings',
    });
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries) {
    if (typeof item !== 'string')
      throw new DeclaredError(causes.ARGUMENT_TYPE, {
        name: `${name}.${key}`,
        value: shown(item),
        expected: 'a string',
      });
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function requiredNumber(value: unknown, name: string): number {
  const number = asOptionalNumber(value, name);
  if (number === undefined)
    throw new DeclaredError(causes.ARGUMENT_MISSING, {
      name,
      value: shown(value),
    });
  return number;
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined)
    throw new DeclaredError(causes.ARGUMENT_MISSING, {
      name,
      value: shown(value),
    });
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new DeclaredError(causes.ARGUMENT_TYPE, {
      name,
      value: shown(value),
      expected: 'an array of strings',
    });
  return value as string[];
}

async function queryElement(args: Record<string, unknown>) {
  const locator = getPage(args.pageId).locator(
    asString(args.selector, 'selector'),
  );
  const count = await locator.count();
  if (count === 0)
    return { count, visible: false, enabled: false, attributes: {} };
  const first = locator.first();
  const attributeValues: Record<string, string | null> = {};
  if (args.attributes !== undefined) {
    for (const attribute of stringList(args.attributes, 'attributes')) {
      attributeValues[attribute] = await first.getAttribute(attribute);
    }
  }
  const kind = await first.evaluate((element) => ({
    html: element instanceof HTMLElement,
    editable:
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement,
    // The CSS :checked state, which only a checked checkbox, radio or option
    // can hold; no list of input types decides it.
    checked: element.matches(':checked'),
  }));
  const state: Record<string, unknown> = {
    count,
    visible: await first.isVisible(),
    enabled: await first.isEnabled(),
    text: kind.html ? await first.innerText() : await first.textContent(),
    attributes: attributeValues,
  };
  state.checked = kind.checked;
  if (kind.editable) state.value = await first.inputValue();
  return state;
}

// A Playwright storage-state file (cookies, and localStorage per origin) is
// applied the way a context created with it would be: cookies at once, and
// each origin's localStorage once per tab session, on its first document.
async function applyStorage(args: Record<string, unknown>) {
  const path = asString(args.path, 'path');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new DeclaredError(
      causes.STORAGE_UNREADABLE,
      { path, answer: messageOf(error) },
      { cause: error },
    );
  }
  let state: { cookies?: unknown; origins?: unknown };
  try {
    state = JSON.parse(text);
  } catch (error) {
    throw new DeclaredError(
      causes.STORAGE_NOT_STATE,
      { path, answer: `it is not JSON: ${messageOf(error)}` },
      { cause: error },
    );
  }
  if (
    !state ||
    typeof state !== 'object' ||
    !Array.isArray(state.cookies) ||
    !Array.isArray(state.origins)
  ) {
    throw new DeclaredError(causes.STORAGE_NOT_STATE, {
      path,
      answer: `it holds ${state && typeof state === 'object' ? `the keys ${Object.keys(state).join(', ') || 'none'}` : shown(state)}, not cookies and origins arrays`,
    });
  }
  const { context } = getBrowser(args.browserId);
  if (state.cookies.length) await context.addCookies(state.cookies as Cookie[]);
  const script = `(() => {
    const own = ${JSON.stringify(state.origins)}.find((entry) => entry.origin === location.origin);
    if (!own || sessionStorage.getItem('__welesStorageApplied') === '1') return;
    for (const item of own.localStorage || []) localStorage.setItem(item.name, item.value);
    sessionStorage.setItem('__welesStorageApplied', '1');
  })();`;
  await context.addInitScript({ content: script });
  return { cookies: state.cookies.length, origins: state.origins.length };
}

export async function callPageOperation(
  name: string,
  args: Record<string, unknown>,
) {
  if (name === 'weles_browser_headers') {
    const headers = stringRecord(args.headers, 'headers');
    await getBrowser(args.browserId).context.setExtraHTTPHeaders(headers);
    return textResult({ headers: Object.keys(headers) });
  }
  if (name === 'weles_browser_storage')
    return textResult(await applyStorage(args));
  if (name === 'weles_page_reload') {
    const page = getPage(args.pageId);
    const load = (
      typeof args.waitUntil === 'string' ? args.waitUntil : 'domcontentloaded'
    ) as LoadState;
    if (typeof args.awaitResponse === 'string') {
      const part = args.awaitResponse;
      const [answered] = await Promise.all([
        page.waitForResponse(
          (response) => response.url().includes(part) && response.ok(),
        ),
        page.reload({ waitUntil: load }),
      ]);
      return textResult({
        url: page.url(),
        awaited: { url: answered.url(), status: answered.status() },
      });
    }
    const response = await page.reload({ waitUntil: load });
    return textResult({ url: page.url(), status: response?.status() });
  }
  if (name === 'weles_page_wait_for') {
    const expression = asString(args.expression, 'expression');
    const handle = await getPage(args.pageId).waitForFunction(expression);
    return textResult(JSON.stringify(await handle.jsonValue()));
  }
  if (name === 'weles_page_viewport') {
    const width = requiredNumber(args.width, 'width');
    const height = requiredNumber(args.height, 'height');
    await getPage(args.pageId).setViewportSize({ width, height });
    return textResult({ width, height });
  }
  if (name === 'weles_page_init_script') {
    await getPage(args.pageId).addInitScript({
      content: asString(args.script, 'script'),
    });
    return textResult({ added: true });
  }
  if (name === 'weles_page_route') {
    const pattern = asString(args.pattern, 'pattern');
    const status = requiredNumber(args.status, 'status');
    const contentType = asString(args.contentType, 'contentType');
    const body = typeof args.body === 'string' ? args.body : '';
    await getPage(args.pageId).route(pattern, (route) =>
      route.fulfill({ status, contentType, body }),
    );
    return textResult({ routed: pattern, status });
  }
  if (name === 'weles_page_unroute') {
    const pattern = asString(args.pattern, 'pattern');
    await getPage(args.pageId).unroute(pattern);
    return textResult({ unrouted: pattern });
  }
  if (name === 'weles_page_query') return textResult(await queryElement(args));
  if (name === 'weles_page_wait') {
    const state = (
      typeof args.state === 'string' ? args.state : 'visible'
    ) as ElementState;
    const selector = asString(args.selector, 'selector');
    await getPage(args.pageId).locator(selector).first().waitFor({ state });
    return textResult({ selector, state });
  }
  if (name === 'weles_page_press') {
    const selector = asString(args.selector, 'selector');
    const key = asString(args.key, 'key');
    await getPage(args.pageId).locator(selector).first().press(key);
    return textResult({ pressed: key, selector });
  }
  if (name === 'weles_page_check') {
    const selector = asString(args.selector, 'selector');
    await getPage(args.pageId)
      .locator(selector)
      .first()
      .setChecked(args.checked !== false);
    return textResult({ selector, checked: args.checked !== false });
  }
  if (name === 'weles_page_upload') {
    const selector = asString(args.selector, 'selector');
    const files = stringList(args.files, 'files');
    await getPage(args.pageId).locator(selector).first().setInputFiles(files);
    return textResult({ selector, files: files.length });
  }
  if (name === 'weles_page_request') {
    const page = getPage(args.pageId);
    const method =
      typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
    const options: {
      method: string;
      headers?: Record<string, string>;
      data?: string;
    } = { method };
    if (args.headers !== undefined)
      options.headers = stringRecord(args.headers, 'headers');
    if (typeof args.body === 'string') options.data = args.body;
    const response = await page.request.fetch(
      asString(args.url, 'url'),
      options,
    );
    return textResult({
      url: response.url(),
      status: response.status(),
      ok: response.ok(),
      body: await response.text(),
    });
  }
  if (name === 'weles_page_events') {
    const events = getPageEvents(args.pageId);
    const snapshot = {
      consoleErrors: [...events.consoleErrors],
      failedRequests: [...events.failedRequests],
      responses: [...events.responses],
    };
    if (args.clear === true) {
      events.consoleErrors.length = 0;
      events.failedRequests.length = 0;
      events.responses.length = 0;
    }
    return textResult(snapshot);
  }
  return undefined;
}
