// The tools the Weles MCP server advertises: one entry per browser operation,
// each with the exact JSON schema its arguments must satisfy. The server in
// `../mcp.ts` dispatches by these names.

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

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
