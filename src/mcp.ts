#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsyncNewBrowserOptions } from './async_api.js';
import { callPageOperation } from './mcp/page-ops.js';
import {
  addBrowser,
  addPage,
  asOptionalNumber,
  asString,
  dropBrowser,
  getPage,
  getBrowser,
  textResult,
} from './mcp/state.js';

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

import { welesMcpTools } from './mcp/tools.js';

export { welesMcpTools } from './mcp/tools.js';

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

export async function callWelesMcpTool(name: string, args: Record<string, unknown> = {}) {
  if (name === 'weles_browser_start') {
    routeConsoleToStderr();
    const { AsyncNewBrowser } = await import('./async_api.js');
    const context = await AsyncNewBrowser(browserOptions(args));
    return textResult({ browserId: addBrowser(context) });
  }

  if (name === 'weles_browser_close') {
    const browserId = asString(args.browserId, 'browserId');
    await dropBrowser(browserId).context.close();
    return textResult({ closed: browserId });
  }

  if (name === 'weles_page_new') {
    const browserId = asString(args.browserId, 'browserId');
    const page = await getBrowser(browserId).context.newPage();
    return textResult({ pageId: addPage(browserId, page) });
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
    const type = args.type === 'jpeg' ? 'jpeg' : 'png';
    const quality = type === 'jpeg' && typeof args.quality === 'number' ? args.quality : undefined;
    const shot = await page.screenshot({ path, type, quality, fullPage: args.fullPage === true });
    return textResult(path ? { path } : { mimeType: `image/${type}`, base64: Buffer.from(shot).toString('base64') });
  }

  if (name === 'weles_page_evaluate') {
    const page = getPage(args.pageId);
    const expression = asString(args.expression, 'expression');
    const value = await page.evaluate((source) => (0, eval)(source), expression);
    // Always JSON text: a string value would otherwise reach the caller
    // unquoted and be indistinguishable from a JSON document.
    return textResult(JSON.stringify(value === undefined ? null : value));
  }

  const result = await callPageOperation(name, args);
  if (result) return result;
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
