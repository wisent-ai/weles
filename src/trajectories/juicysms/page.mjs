import { pageSettled, responseAfterAction } from '../_shared/page/settled.mjs';

async function completedResponse(first, operation) {
  let request = first.request();
  let redirected;
  while ((redirected = request.redirectedTo())) request = redirected;
  const response = await request.response();
  const details = {
    operation,
    requestUrl: first.request().url(),
    responseUrl: response?.url() ?? null,
    status: response?.status() ?? null,
  };
  if (!response?.ok()) {
    throw Object.assign(
      new Error('JuicySMS did not return a successful response'),
      {
        code: 'JUICYSMS_PAGE_HTTP_ERROR',
        ...details,
        errorText: request.failure()?.errorText ?? null,
      },
    );
  }
  const cause = await response.finished();
  if (cause)
    throw Object.assign(
      new Error('JuicySMS response did not finish', { cause }),
      {
        code: 'JUICYSMS_PAGE_RESPONSE_FAILED',
        ...details,
      },
    );
  return response;
}

// Keep WSession's navigation evidence and challenge handling, and inspect the
// response belonging to that navigation rather than an unrelated page request.
export async function openJuicyPage(session, address) {
  const expected = new URL(address);
  const first = await responseAfterAction(
    session.page,
    (request) =>
      request.url() === expected.href &&
      request.isNavigationRequest() &&
      request.frame() === session.page.mainFrame(),
    () => session.goto(expected.href),
  );
  const response = await completedResponse(first, 'navigate');
  await pageSettled(session.page);
  const observed = new URL(session.page.url());
  if (
    observed.origin !== expected.origin ||
    observed.pathname.replace(/\/$/, '') !==
      expected.pathname.replace(/\/$/, '')
  ) {
    throw Object.assign(
      new Error('JuicySMS navigation reached a different route'),
      {
        code: 'JUICYSMS_PAGE_DESTINATION_MISMATCH',
        requestedUrl: expected.href,
        responseUrl: response.url(),
        status: response.status(),
        pageUrl: observed.href,
      },
    );
  }
  return response;
}

// Inertia returns JSON to its client and an encoded data-page attribute on a
// full document load. Read the received state, not a stale SPA bootstrap node.
export async function readJuicyPage(first, component) {
  const response = await completedResponse(first, `read ${component}`);
  const details = {
    responseUrl: response.url(),
    status: response.status(),
    expectedComponent: component,
  };
  let body;
  try {
    body = await response.text();
  } catch (cause) {
    throw Object.assign(
      new Error('JuicySMS page body could not be read', { cause }),
      {
        code: 'JUICYSMS_PAGE_BODY_FAILED',
        ...details,
      },
    );
  }
  const contentType = (response.headers()['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType === 'text/html') {
    const match = body.match(/data-page="([^"]+)"/);
    if (!match)
      throw Object.assign(
        new Error('JuicySMS document has no Inertia page state'),
        {
          code: 'JUICYSMS_PAGE_STATE_MISSING',
          ...details,
        },
      );
    const entities = { quot: '"', amp: '&', '#039': "'", lt: '<', gt: '>' };
    body = match[1].replace(
      /&(quot|amp|#039|lt|gt);/g,
      (_, key) => entities[key],
    );
  } else if (contentType !== 'application/json') {
    throw Object.assign(
      new Error('JuicySMS page response has an unsupported content type'),
      {
        code: 'JUICYSMS_PAGE_CONTENT_TYPE_UNSUPPORTED',
        ...details,
        contentType,
      },
    );
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (cause) {
    throw Object.assign(
      new Error('JuicySMS page state is not valid JSON', { cause }),
      {
        code: 'JUICYSMS_PAGE_STATE_INVALID',
        ...details,
      },
    );
  }
  if (
    data?.component !== component ||
    !data.props ||
    typeof data.props !== 'object' ||
    Array.isArray(data.props)
  ) {
    throw Object.assign(
      new Error('JuicySMS returned a different or incomplete page'),
      {
        code: 'JUICYSMS_PAGE_COMPONENT_MISMATCH',
        ...details,
        observedComponent: data?.component ?? null,
        errors: data?.props?.errors ?? null,
      },
    );
  }
  return data.props;
}
