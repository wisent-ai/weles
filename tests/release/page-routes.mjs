// Page routes of a real, running Weles API: the same process renders a public
// page for a product that must not launch a browser of its own, behind the
// general API bearer. Called by the packaging test against the process it
// started from the compiled payload; every answer is kept in the report.
import assert from 'node:assert/strict';

const PUBLIC_PAGE = 'https://example.com/';
const PUBLIC_PAGE_TITLE = 'Example Domain';
const REPORTED_BODY_CHARS = 2000;
const EMPTY = 0;

export async function checkPageRoutes({ port, token, reportedRoutes, report }) {
  assert.ok(reportedRoutes.includes('POST /pages/snapshot'), JSON.stringify(reportedRoutes));
  assert.ok(reportedRoutes.includes('POST /pages/form-export'), JSON.stringify(reportedRoutes));
  const pagesAt = (route, body, headers = { authorization: `Bearer ${token}` }) => fetch(
    `http://127.0.0.1:${port}${route}`,
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  report.page_routes = [];

  const unauthorized = await pagesAt('/pages/snapshot', { url: PUBLIC_PAGE }, {});
  report.page_routes.push({ case: 'no bearer', status: unauthorized.status, body: await unauthorized.json() });
  assert.equal(unauthorized.status, 401);

  const invalid = await pagesAt('/pages/form-export', { url: PUBLIC_PAGE, fields: [] });
  const invalidBody = await invalid.json();
  report.page_routes.push({ case: 'missing click_text', status: invalid.status, body: invalidBody });
  assert.equal(invalid.status, 400, JSON.stringify(invalidBody));
  assert.equal(invalidBody.field, 'click_text');

  const loopback = await pagesAt('/pages/snapshot', { url: 'https://127.0.0.1/' });
  const loopbackBody = await loopback.json();
  report.page_routes.push({ case: 'loopback target', status: loopback.status, body: loopbackBody });
  assert.equal(loopback.status, 422, JSON.stringify(loopbackBody));
  assert.equal(loopbackBody.code, 'target_refused');

  const read = await pagesAt('/pages/snapshot', { url: PUBLIC_PAGE, screenshot: 'viewport' });
  const readBody = await read.json();
  report.page_routes.push({
    case: 'public page snapshot',
    status: read.status,
    title: readBody.data?.structured?.title,
    screenshot_bytes: readBody.data?.screenshot?.bytes,
    error: readBody.error,
  });
  assert.equal(read.status, 200, JSON.stringify(readBody).slice(EMPTY, REPORTED_BODY_CHARS));
  assert.equal(readBody.data.structured.title, PUBLIC_PAGE_TITLE);
  assert.equal(readBody.data.screenshot.embedded, true);
  assert.ok(Buffer.from(readBody.data.screenshot.base64, 'base64').byteLength > EMPTY);
}
