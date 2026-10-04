// The browser contexts and pages one Weles MCP server holds, by the ids it
// handed out, and what each page has reported since it was opened: console
// errors, failed requests and finished responses. A caller reads those events
// through weles_page_events instead of subscribing to the engine itself; every
// event is kept until that read or until the page closes.

import type { BrowserContext, Page } from 'playwright';

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

let nextBrowserId = 1;
let nextPageId = 1;

export function addBrowser(context: BrowserContext): string {
  const browserId = `browser-${nextBrowserId++}`;
  browsers.set(browserId, { context, pages: new Set() });
  return browserId;
}

export function addPage(browserId: string, page: Page): string {
  const pageId = `page-${nextPageId++}`;
  const events: PageEvents = { consoleErrors: [], failedRequests: [], responses: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') events.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    events.failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (response) => {
    events.responses.push({ url: response.url(), status: response.status(), method: response.request().method() });
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

export function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function asOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function getBrowser(browserId: unknown): BrowserSlot {
  const id = asString(browserId, 'browserId');
  const browser = browsers.get(id);
  if (!browser) throw new Error(`unknown browserId: ${id}`);
  return browser;
}

export function getPage(pageId: unknown): Page {
  const id = asString(pageId, 'pageId');
  const page = pages.get(id);
  if (!page) throw new Error(`unknown pageId: ${id}`);
  return page;
}

export function getPageEvents(pageId: unknown): PageEvents {
  const id = asString(pageId, 'pageId');
  const events = pageEvents.get(id);
  if (!events) throw new Error(`unknown pageId: ${id}`);
  return events;
}

export function textResult(value: unknown) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}
