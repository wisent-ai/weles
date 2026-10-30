#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsyncNewBrowserOptions } from './async_api.js';
import { DeclaredError } from './errors/index.cjs';
import { causes, engineCause } from './errors/operations/browser.cjs';
import { callPageOperation } from './mcp/page-ops.js';
import {
  addBrowser,
  addPage,
  asString,
  dropBrowser,
  getPage,
  getBrowser,
  shown,
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

// The version the server reports in its initialize answer is the installed
// package's; a package file that cannot be read or names no version is a
// broken install, refused with its path rather than reported as "unknown".
function packageVersion(): string {
  const path = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
  if (typeof pkg.version !== 'string')
    throw new Error(`Weles package file ${path} names no version`);
  return pkg.version;
}

/** The engines and operating systems weles_browser_start declares. */
const ENGINES = ['chromium', 'firefox'];
const SYSTEMS = ['macos', 'windows', 'linux'];

/** `value` of argument `name`, refused unless it is one of `allowed`. */
function oneOf(
  value: unknown,
  name: string,
  allowed: string[],
  unknown: typeof causes.ENGINE_UNKNOWN,
): string {
  const text = asString(value, name);
  if (!allowed.includes(text))
    throw new DeclaredError(unknown, { value: shown(text) });
  return text;
}

function browserOptions(args: Record<string, unknown>): AsyncNewBrowserOptions {
  const options: AsyncNewBrowserOptions = {
    browser: oneOf(args.browser, 'browser', ENGINES, causes.ENGINE_UNKNOWN),
    os: oneOf(args.os, 'os', SYSTEMS, causes.OS_UNKNOWN),
  };
  if (typeof args.headless === 'boolean') options.headless = args.headless;
  if (typeof args.locale === 'string') options.locale = args.locale;
  if (typeof args.userDataDir === 'string')
    options.userDataDir = args.userDataDir;
  if (typeof args.proxy === 'string') options.proxy = { server: args.proxy };
  return options;
}

/**
 * Call one tool. Every failure is a declared cause of the browser session
 * catalogue: an argument or id this server refuses is raised as such, and
 * what the browser engine reports is classified by its own words and quoted
 * whole, naming the tool and page it happened on.
 */
export async function callWelesMcpTool(
  name: string,
  args: Record<string, unknown> = {},
) {
  try {
    return await dispatchTool(name, args);
  } catch (error) {
    const page = typeof args.pageId === 'string' ? args.pageId : 'none';
    const values: Record<string, string> = { tool: name, page };
    if (typeof args.url === 'string') values.url = args.url;
    if (typeof args.method === 'string') values.method = args.method;
    else values.method = 'GET';
    if (typeof args.browser === 'string') values.engine = args.browser;
    if (typeof args.userDataDir === 'string') values.profile = args.userDataDir;
    if (error instanceof DeclaredError) throw error.naming(values);
    throw engineCause(error, values);
  }
}

async function dispatchTool(name: string, args: Record<string, unknown>) {
  if (name === 'weles_browser_start') {
    const options = browserOptions(args);
    routeConsoleToStderr();
    const { AsyncNewBrowser } = await import('./async_api.js');
    const context = await AsyncNewBrowser(options);
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
    const waitUntil =
      typeof args.waitUntil === 'string'
        ? (args.waitUntil as
            | 'load'
            | 'domcontentloaded'
            | 'networkidle'
            | 'commit')
        : 'domcontentloaded';
    const response = await page.goto(url, { waitUntil });
    // Playwright answers no response for a navigation that stays on the
    // document (a hash change, about:blank); its status is then none.
    return textResult({
      url: page.url(),
      status: response ? response.status() : null,
      title: await page.title(),
    });
  }

  if (name === 'weles_page_text') {
    const page = getPage(args.pageId);
    const selector = typeof args.selector === 'string' ? args.selector : 'body';
    const text = await page.locator(selector).innerText();
    return textResult(text);
  }

  if (name === 'weles_page_click') {
    const page = getPage(args.pageId);
    await page.locator(asString(args.selector, 'selector')).click();
    return textResult({ clicked: args.selector });
  }

  if (name === 'weles_page_fill') {
    const page = getPage(args.pageId);
    const selector = asString(args.selector, 'selector');
    await page.locator(selector).fill(asString(args.value, 'value'));
    return textResult({ filled: selector });
  }

  if (name === 'weles_page_screenshot') {
    const page = getPage(args.pageId);
    const path = typeof args.path === 'string' ? args.path : undefined;
    const type = args.type === 'jpeg' ? 'jpeg' : 'png';
    const quality =
      type === 'jpeg' && typeof args.quality === 'number'
        ? args.quality
        : undefined;
    const shot = await page.screenshot({
      path,
      type,
      quality,
      fullPage: args.fullPage === true,
    });
    return textResult(
      path
        ? { path }
        : {
            mimeType: `image/${type}`,
            base64: Buffer.from(shot).toString('base64'),
          },
    );
  }

  if (name === 'weles_page_evaluate') {
    const page = getPage(args.pageId);
    const expression = asString(args.expression, 'expression');
    // Indirect eval runs the expression in the page's global scope.
    const value = await page.evaluate((source) => {
      const evaluate = eval;
      return evaluate(source);
    }, expression);
    // Always JSON text: a string value would otherwise reach the caller
    // unquoted and be indistinguishable from a JSON document.
    return textResult(JSON.stringify(value === undefined ? null : value));
  }

  const result = await callPageOperation(name, args);
  if (result) return result;
  throw new DeclaredError(causes.TOOL_UNKNOWN, {
    tool: name,
    tools: welesMcpTools.map((tool) => tool.name).join(', '),
  });
}

/**
 * A JSON-RPC error of a failure: the declared cause's sentence as the
 * message and its cause, fix and documentation as `data`. A failure that is
 * not a declared cause is this server's own defect, answered with its words.
 */
function rpcError(error: unknown): {
  code: number;
  message: string;
  data?: unknown;
} {
  if (error instanceof DeclaredError)
    return { code: -32000, message: error.message, data: error.answer() };
  return {
    code: -32000,
    message: `weles mcp failed outside its declared causes, which is its defect: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function send(message: JsonRpcResponse | Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request: JsonRpcRequest): Promise<void> {
  if (!request.method) return;
  // A request without an id is a notification and is answered by nothing;
  // JSON carries no undefined, so an id that is absent is one never sent.
  const { id } = request;
  if (id === undefined) return;

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
      const { params } = request;
      if (!params) throw new DeclaredError(causes.CALL_WITHOUT_PARAMS);
      const name = asString(params.name, 'name');
      const args =
        params.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {};
      const result = await callWelesMcpTool(name, args);
      send({ jsonrpc: '2.0', id, result });
      return;
    }

    const unknown = new DeclaredError(causes.METHOD_UNKNOWN, {
      method: request.method,
    });
    send({
      jsonrpc: '2.0',
      id,
      // https://www.jsonrpc.org/specification#error_object (method not found)
      error: { code: -32601, message: unknown.message, data: unknown.answer() },
    });
  } catch (error) {
    // A refusal raised before any tool was named (tools/call without a name)
    // names the method it refused.
    const named =
      error instanceof DeclaredError
        ? error.naming({ tool: String(request.method) })
        : error;
    // https://www.jsonrpc.org/specification#error_object (server error range)
    send({ jsonrpc: '2.0', id, error: rpcError(named) });
  }
}

export function startMcpServer(): void {
  routeConsoleToStderr();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    // Each request is one line; the text after the last newline is a request
    // still arriving and stays buffered for the next chunk.
    const lines = `${buffer}${chunk}`.split('\n');
    buffer = String(lines.pop());
    for (const received of lines) {
      const line = received.trim();
      if (!line) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch (error) {
        const refused = new DeclaredError(
          causes.REQUEST_NOT_JSON,
          { answer: error instanceof Error ? error.message : String(error) },
          { cause: error },
        );
        send({
          jsonrpc: '2.0',
          id: null,
          // https://www.jsonrpc.org/specification#error_object (parse error)
          error: {
            code: -32700,
            message: refused.message,
            data: refused.answer(),
          },
        });
        continue;
      }
      void handle(request);
    }
  });
}

if (require.main === module) {
  startMcpServer();
}
