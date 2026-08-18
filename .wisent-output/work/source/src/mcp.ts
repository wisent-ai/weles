#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { AsyncNewBrowserOptions } from './async_api.js';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type BrowserSlot = {
  context: BrowserContext;
  pages: Set<string>;
};

const browsers = new Map<string, BrowserSlot>();
const pages = new Map<string, Page>();
let nextBrowserId = 1;
let nextPageId = 1;
let consoleRoutedToStderr = false;

// MCP stdio is a protocol stream. Weles launch/session diagnostics use console.log;
// keep diagnostics on stderr while the server is active so stdout remains JSON-RPC only.
function routeConsoleToStderr(): void {
  if (consoleRoutedToStderr) return;
  console.log = (...args: unknown[]) => console.error(...args);
  consoleRoutedToStderr = true;
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const welesMcpTools: ToolDefinition[] = [
  {
    name: 'weles_browser_start',
    description: 'Launch a Weles browser context via AsyncNewBrowser and return a browserId.',
    inputSchema: objectSchema({
      headless: { type: 'boolean', description: 'Run without a visible browser window.' },
      browser: { type: 'string', enum: ['chromium', 'firefox'], description: 'Browser engine.' },
      os: { type: 'string', description: 'Persona OS, for example macos.' },
      locale: { type: 'string', description: 'Locale, for example en-US.' },
      chromiumPath: { type: 'string', description: 'Custom Chromium binary path.' },
      userDataDir: { type: 'string', description: 'Persistent browser profile directory.' },
      proxy: { type: 'string', description: 'Proxy server URL.' },
    }),
  },
  {
    name: 'weles_browser_close',
    description: 'Close a Weles browser context and all tracked pages for it.',
    inputSchema: objectSchema({ browserId: { type: 'string' } }, ['browserId']),
  },
  {
    name: 'weles_page_new',
    description: 'Create a new page in a Weles browser context and return a pageId.',
    inputSchema: objectSchema({ browserId: { type: 'string' } }, ['browserId']),
  },
  {
    name: 'weles_page_goto',
    description: 'Navigate a tracked Weles page to a URL.',
    inputSchema: objectSchema({
      pageId: { type: 'string' },
      url: { type: 'string' },
      waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'] },
      timeout: { type: 'number' },
    }, ['pageId', 'url']),
  },
  {
    name: 'weles_page_text',
    description: 'Read visible text from a Weles page or selector.',
    inputSchema: objectSchema({
      pageId: { type: 'string' },
      selector: { type: 'string', description: 'Optional CSS selector. Defaults to body.' },
      timeout: { type: 'number' },
    }, ['pageId']),
  },
  {
    name: 'weles_page_click',
    description: 'Click a CSS selector on a Weles page.',
    inputSchema: objectSchema({
      pageId: { type: 'string' },
      selector: { type: 'string' },
      timeout: { type: 'number' },
    }, ['pageId', 'selector']),
  },
  {
    name: 'weles_page_fill',
    description: 'Fill a CSS selector on a Weles page.',
    inputSchema: objectSchema({
      pageId: { type: 'string' },
      selector: { type: 'string' },
      value: { type: 'string' },
      timeout: { type: 'number' },
    }, ['pageId', 'selector', 'value']),
  },
  {
    name: 'weles_page_screenshot',
    description: 'Capture a Weles page screenshot. Saves to path when provided, otherwise returns base64 PNG.',
    inputSchema: objectSchema({
      pageId: { type: 'string' },
      path: { type: 'string' },
      fullPage: { type: 'boolean' },
    }, ['pageId']),
  },
  {
    name: 'weles_page_evaluate',
    description: 'Evaluate a JavaScript expression in a Weles page and return the JSON-serializable result.',
    inputSchema: objectSchema({
      pageId: { type: 'string' },
      expression: { type: 'string' },
    }, ['pageId', 'expression']),
  },
];

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function asOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function browserOptions(args: Record<string, unknown>): AsyncNewBrowserOptions {
  const options: AsyncNewBrowserOptions = {};
  if (typeof args.headless === 'boolean') options.headless = args.headless;
  if (typeof args.browser === 'string') options.browser = args.browser;
  if (typeof args.os === 'string') options.os = args.os;
  if (typeof args.locale === 'string') options.locale = args.locale;
  if (typeof args.chromiumPath === 'string') options.chromiumPath = args.chromiumPath;
  if (typeof args.userDataDir === 'string') options.userDataDir = args.userDataDir;
  if (typeof args.proxy === 'string') options.proxy = { server: args.proxy };
  return options;
}

function getBrowser(browserId: unknown): BrowserSlot {
  const id = asString(browserId, 'browserId');
  const browser = browsers.get(id);
  if (!browser) throw new Error(`unknown browserId: ${id}`);
  return browser;
}

function getPage(pageId: unknown): Page {
  const id = asString(pageId, 'pageId');
  const page = pages.get(id);
  if (!page) throw new Error(`unknown pageId: ${id}`);
  return page;
}

function textResult(value: unknown) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

export async function callWelesMcpTool(name: string, args: Record<string, unknown> = {}) {
  if (name === 'weles_browser_start') {
    routeConsoleToStderr();
    const { AsyncNewBrowser } = await import('./async_api.js');
    const context = await AsyncNewBrowser(browserOptions(args));
    const browserId = `browser-${nextBrowserId++}`;
    browsers.set(browserId, { context, pages: new Set() });
    return textResult({ browserId });
  }

  if (name === 'weles_browser_close') {
    const browserId = asString(args.browserId, 'browserId');
    const browser = getBrowser(browserId);
    for (const pageId of browser.pages) pages.delete(pageId);
    browsers.delete(browserId);
    await browser.context.close();
    return textResult({ closed: browserId });
  }

  if (name === 'weles_page_new') {
    const browserId = asString(args.browserId, 'browserId');
    const browser = getBrowser(browserId);
    const page = await browser.context.newPage();
    const pageId = `page-${nextPageId++}`;
    pages.set(pageId, page);
    browser.pages.add(pageId);
    return textResult({ pageId });
  }

  if (name === 'weles_page_goto') {
    const page = getPage(args.pageId);
    const url = asString(args.url, 'url');
    const waitUntil = typeof args.waitUntil === 'string' ? args.waitUntil as 'load' | 'domcontentloaded' | 'networkidle' | 'commit' : 'domcontentloaded';
    const response = await page.goto(url, { waitUntil, timeout: asOptionalNumber(args.timeout, 'timeout') });
    return textResult({ url: page.url(), status: response?.status() ?? null, title: await page.title().catch(() => '') });
  }

  if (name === 'weles_page_text') {
    const page = getPage(args.pageId);
    const selector = typeof args.selector === 'string' ? args.selector : 'body';
    const text = await page.locator(selector).innerText({ timeout: asOptionalNumber(args.timeout, 'timeout') ?? 5000 });
    return textResult(text);
  }

  if (name === 'weles_page_click') {
    const page = getPage(args.pageId);
    await page.locator(asString(args.selector, 'selector')).click({ timeout: asOptionalNumber(args.timeout, 'timeout') });
    return textResult({ clicked: args.selector });
  }

  if (name === 'weles_page_fill') {
    const page = getPage(args.pageId);
    const selector = asString(args.selector, 'selector');
    await page.locator(selector).fill(asString(args.value, 'value'), { timeout: asOptionalNumber(args.timeout, 'timeout') });
    return textResult({ filled: selector });
  }

  if (name === 'weles_page_screenshot') {
    const page = getPage(args.pageId);
    const path = typeof args.path === 'string' ? args.path : undefined;
    const shot = await page.screenshot({ path, fullPage: args.fullPage === true });
    return textResult(path ? { path } : { mimeType: 'image/png', base64: Buffer.from(shot).toString('base64') });
  }

  if (name === 'weles_page_evaluate') {
    const page = getPage(args.pageId);
    const expression = asString(args.expression, 'expression');
    const value = await page.evaluate((source) => (0, eval)(source), expression);
    return textResult(value ?? null);
  }

  throw new Error(`unknown tool: ${name}`);
}

function send(message: JsonRpcResponse | Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request: JsonRpcRequest): Promise<void> {
  if (!request.method) return;
  const hasResponseId = Object.prototype.hasOwnProperty.call(request, 'id');
  if (!hasResponseId) return;
  const id = request.id ?? null;

  try {
    if (request.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'weles', version: packageVersion() },
        },
      });
      return;
    }

    if (request.method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (request.method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: welesMcpTools } });
      return;
    }

    if (request.method === 'tools/call') {
      const params = request.params ?? {};
      const name = asString(params.name, 'name');
      const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments as Record<string, unknown> : {};
      const result = await callWelesMcpTool(name, args);
      send({ jsonrpc: '2.0', id, result });
      return;
    }

    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${request.method}` } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }
}

export function startMcpServer(): void {
  routeConsoleToStderr();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      void handle(request);
    }
  });
}

if (require.main === module) {
  startMcpServer();
}
