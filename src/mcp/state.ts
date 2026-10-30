// The browser contexts and pages one Weles MCP server holds, by the ids it
// handed out, and what each page has reported since it was opened: console
// errors, failed requests and finished responses. A caller reads those events
// through weles_page_events instead of subscribing to the engine itself; every
// event is kept until that read or until the page closes.

import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import { DeclaredError } from '../errors/index.cjs';
import { causes } from '../errors/operations/browser.cjs';

/** The indentation a structured result is printed with, for a person to read. */
const INDENT = '  ';

export type BrowserSlot = {
  context: BrowserContext;
  pages: Set<string>;
};

export type PageEvents = {
  consoleErrors: string[];
  failedRequests: string[];
  responses: { url: string; status: number; method: string }[];
};

export const browsers = new Map<string, BrowserSlot>();
export const pages = new Map<string, Page>();
export const pageEvents = new Map<string, PageEvents>();

// Ids are opaque handles the server hands out; each is drawn fresh, so one
// cannot be guessed from another or reused after a restart.
export function addBrowser(context: BrowserContext): string {
  const browserId = `browser-${randomUUID()}`;
  browsers.set(browserId, { context, pages: new Set() });
  return browserId;
}

export function addPage(browserId: string, page: Page): string {
  const pageId = `page-${randomUUID()}`;
  const events: PageEvents = {
    consoleErrors: [],
    failedRequests: [],
    responses: [],
  };
  page.on('console', (message) => {
    if (message.type() === 'error') events.consoleErrors.push(message.text());
  });
  // Playwright fires requestfailed only for a request that failed, and
  // states its reason as failure().errorText; a failure it states without
  // one is recorded as stating none.
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    const reason = failure
      ? failure.errorText
      : 'no reason stated by the browser';
    events.failedRequests.push(
      `${request.method()} ${request.url()} — ${reason}`,
    );
  });
  page.on('response', (response) => {
    events.responses.push({
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
    });
  });
  pages.set(pageId, page);
  pageEvents.set(pageId, events);
  getBrowser(browserId).pages.add(pageId);
  return pageId;
}

export function dropBrowser(browserId: string): BrowserSlot {
  const browser = getBrowser(browserId);
  for (const pageId of browser.pages) {
    pages.delete(pageId);
    pageEvents.delete(pageId);
  }
  browsers.delete(browserId);
  return browser;
}

/** A value as a refusal shows it: JSON, or what JSON has no form for. */
export function shown(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? 'not given' : text;
}

export function asString(value: unknown, name: string): string {
  if (value === undefined || value === '')
    throw new DeclaredError(causes.ARGUMENT_MISSING, {
      name,
      value: shown(value),
    });
  if (typeof value !== 'string')
    throw new DeclaredError(causes.ARGUMENT_TYPE, {
      name,
      value: shown(value),
      expected: 'a non-empty string',
    });
  return value;
}

export function asOptionalNumber(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  // The smallest positive number a double holds bounds the positive ones.
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < Number.MIN_VALUE
  )
    throw new DeclaredError(causes.ARGUMENT_TYPE, {
      name,
      value: shown(value),
      expected: 'a positive number',
    });
  return value;
}

export function getBrowser(browserId: unknown): BrowserSlot {
  const id = asString(browserId, 'browserId');
  const browser = browsers.get(id);
  if (!browser)
    throw new DeclaredError(causes.BROWSER_ID_UNKNOWN, {
      id,
      open: browsers.size ? [...browsers.keys()].join(', ') : 'none',
    });
  return browser;
}

function unknownPage(id: string): DeclaredError {
  return new DeclaredError(causes.PAGE_ID_UNKNOWN, {
    id,
    open: pages.size ? [...pages.keys()].join(', ') : 'none',
  });
}

export function getPage(pageId: unknown): Page {
  const id = asString(pageId, 'pageId');
  const page = pages.get(id);
  if (!page) throw unknownPage(id);
  return page;
}

export function getPageEvents(pageId: unknown): PageEvents {
  const id = asString(pageId, 'pageId');
  const events = pageEvents.get(id);
  if (!events) throw unknownPage(id);
  return events;
}

export function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text',
        text:
          typeof value === 'string'
            ? value
            : JSON.stringify(value, null, INDENT),
      },
    ],
  };
}
