// Schemas of the page operations in ./page-ops.ts. Selectors are Playwright
// selector strings: CSS, or role=/text=/internal:label= engines.

import { objectSchema, type ToolDefinition } from './schema.js';

const page = { pageId: { type: 'string' } };
const selector = {
  selector: {
    type: 'string',
    description:
      'Playwright selector: CSS, role=button[name="…"], text=…, internal:label="…".',
  },
};

export const welesPageTools: ToolDefinition[] = [
  {
    name: 'weles_browser_headers',
    description:
      'Send these extra HTTP headers with every request of a Weles browser context.',
    inputSchema: objectSchema(
      {
        browserId: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
      },
      ['browserId', 'headers'],
    ),
  },
  {
    name: 'weles_browser_storage',
    description:
      'Apply a Playwright storage-state file (cookies, and localStorage per origin) to a Weles browser context, as a context created with it would start.',
    inputSchema: objectSchema(
      {
        browserId: { type: 'string' },
        path: {
          type: 'string',
          description: 'Absolute path of the storage-state JSON.',
        },
      },
      ['browserId', 'path'],
    ),
  },
  {
    name: 'weles_page_reload',
    description:
      'Reload a tracked Weles page and return its URL and HTTP status; with awaitResponse, return once a successful response whose URL contains that text has arrived.',
    inputSchema: objectSchema(
      {
        ...page,
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
        },
        awaitResponse: {
          type: 'string',
          description:
            'Text the awaited response URL contains, for example /api/report.',
        },
      },
      ['pageId'],
    ),
  },
  {
    name: 'weles_page_wait_for',
    description:
      'Wait until a JavaScript expression evaluated in the page is truthy and return its value.',
    inputSchema: objectSchema({ ...page, expression: { type: 'string' } }, [
      'pageId',
      'expression',
    ]),
  },
  {
    name: 'weles_page_viewport',
    description: 'Resize a Weles page viewport.',
    inputSchema: objectSchema(
      { ...page, width: { type: 'number' }, height: { type: 'number' } },
      ['pageId', 'width', 'height'],
    ),
  },
  {
    name: 'weles_page_init_script',
    description:
      "Run this script in every document the page loads from now on, before the document's own scripts.",
    inputSchema: objectSchema({ ...page, script: { type: 'string' } }, [
      'pageId',
      'script',
    ]),
  },
  {
    name: 'weles_page_route',
    description:
      'Answer every request matching a URL glob with this status, content type and body until unrouted.',
    inputSchema: objectSchema(
      {
        ...page,
        pattern: {
          type: 'string',
          description: 'URL glob, for example **/api/report.',
        },
        status: { type: 'number' },
        contentType: { type: 'string' },
        body: { type: 'string' },
      },
      ['pageId', 'pattern', 'status', 'contentType'],
    ),
  },
  {
    name: 'weles_page_unroute',
    description:
      'Stop answering requests matching a URL glob routed with weles_page_route.',
    inputSchema: objectSchema({ ...page, pattern: { type: 'string' } }, [
      'pageId',
      'pattern',
    ]),
  },
  {
    name: 'weles_page_query',
    description:
      'Read the state of the first element a selector matches: count, visible, enabled, checked, text, value and named attributes.',
    inputSchema: objectSchema(
      {
        ...page,
        ...selector,
        attributes: { type: 'array', items: { type: 'string' } },
      },
      ['pageId', 'selector'],
    ),
  },
  {
    name: 'weles_page_wait',
    description:
      'Wait until the first element a selector matches is attached, detached, visible or hidden.',
    inputSchema: objectSchema(
      {
        ...page,
        ...selector,
        state: {
          type: 'string',
          enum: ['attached', 'detached', 'visible', 'hidden'],
        },
      },
      ['pageId', 'selector'],
    ),
  },
  {
    name: 'weles_page_press',
    description:
      'Press a key, for example Enter or ArrowDown, on the first element a selector matches.',
    inputSchema: objectSchema(
      { ...page, ...selector, key: { type: 'string' } },
      ['pageId', 'selector', 'key'],
    ),
  },
  {
    name: 'weles_page_check',
    description: 'Check or uncheck the checkbox or radio a selector matches.',
    inputSchema: objectSchema(
      { ...page, ...selector, checked: { type: 'boolean' } },
      ['pageId', 'selector'],
    ),
  },
  {
    name: 'weles_page_upload',
    description: 'Set the files of the file input a selector matches.',
    inputSchema: objectSchema(
      {
        ...page,
        ...selector,
        files: { type: 'array', items: { type: 'string' } },
      },
      ['pageId', 'selector', 'files'],
    ),
  },
  {
    name: 'weles_page_request',
    description:
      "Send an HTTP request with the page's cookies and context headers and return status and body.",
    inputSchema: objectSchema(
      {
        ...page,
        url: { type: 'string' },
        method: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
      },
      ['pageId', 'url'],
    ),
  },
  {
    name: 'weles_page_events',
    description:
      'Return the console errors, failed requests and responses the page reported since it opened or was last cleared.',
    inputSchema: objectSchema({ ...page, clear: { type: 'boolean' } }, [
      'pageId',
    ]),
  },
];
