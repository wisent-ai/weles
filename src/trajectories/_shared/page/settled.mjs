// Waiting for a page to finish what a navigation or a click started, measured
// by the page itself instead of a clock.
//
// `pageSettled` resolves once the document has loaded and its DOM has gone
// two consecutive animation frames without a mutation. A page that keeps
// changing keeps the wait open; the run's cancellation ends it, and the step
// that follows reports what it found. Nothing here sleeps or gives up on a
// count.
//
// `pageCondition` waits until a predicate evaluated in the page holds, checked
// on every animation frame, and returns its value.

import { DOCUMENT_REPLACED, readAcrossNavigation } from './navigation/read.mjs';

// Runs inside the page: resolves once the document has loaded and its DOM has
// gone two consecutive animation frames without a mutation.
function settleInPage() {
  const { promise, resolve } = Promise.withResolvers();
  const quiet = () => {
    let changed = true;
    let quietFrames = 0;
    const observer = new MutationObserver(() => {
      changed = true;
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const frame = () => {
      quietFrames = changed ? 0 : quietFrames + 1;
      changed = false;
      if (quietFrames >= 2) {
        observer.disconnect();
        resolve();
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
  if (document.readyState === 'complete') quiet();
  else window.addEventListener('load', quiet, { once: true });
  return promise;
}

export async function pageSettled(page) {
  // Both the load and the quiet DOM are awaited inside the page, so no
  // Playwright default limit applies — the page alone decides when it is done.
  // When a navigation replaces the document mid-wait, the new document is the
  // one that has to settle, so the wait moves to it; any other failure is the
  // caller's error.
  while (
    (await readAcrossNavigation(page, () => page.evaluate(settleInPage))) ===
    DOCUMENT_REPLACED
  ) {
    // Observe the replacement document rather than retrying a dead page.
  }
}

export async function pageCondition(page, predicate, arg) {
  const handle = await page.waitForFunction(predicate, arg, { polling: 'raf' });
  try {
    return await handle.jsonValue();
  } finally {
    await handle.dispose();
  }
}

function matchesUrl(pattern, url) {
  if (pattern instanceof RegExp) return pattern.test(url);
  if (typeof pattern === 'function') return pattern(url);
  return url.includes(pattern);
}

// Waits until the main frame's URL matches `pattern` (a RegExp, a predicate
// over the URL, or text the URL must contain) and returns it. It listens to
// the page's own navigations, so it ends when the page gets there, not on a
// clock.
export async function urlMatching(page, pattern) {
  if (page.isClosed())
    throw Object.assign(
      new Error(
        `page closed before its URL matched ${pattern}; last URL ${page.url()}`,
      ),
      { code: 'PAGE_CLOSED', pageUrl: page.url() },
    );
  if (matchesUrl(pattern, page.url())) return page.url();
  const { promise, resolve, reject } = Promise.withResolvers();
  const onNavigated = (frame) => {
    try {
      if (frame !== page.mainFrame() || !matchesUrl(pattern, frame.url()))
        return;
      resolve(frame.url());
    } catch (error) {
      reject(error);
    }
  };
  const onClose = () =>
    reject(
      Object.assign(
        new Error(
          `page closed before its URL matched ${pattern}; last URL ${page.url()}`,
        ),
        { code: 'PAGE_CLOSED', pageUrl: page.url() },
      ),
    );
  const onCrash = () =>
    reject(
      Object.assign(
        new Error(
          `page crashed before its URL matched ${pattern}; last URL ${page.url()}`,
        ),
        { code: 'PAGE_CRASHED', pageUrl: page.url() },
      ),
    );
  page.on('framenavigated', onNavigated);
  page.once('close', onClose);
  page.once('crash', onCrash);
  try {
    return await promise;
  } finally {
    page.off('framenavigated', onNavigated);
    page.off('close', onClose);
    page.off('crash', onCrash);
  }
}

// Owns the action and its popup or main-frame navigation observation.
// Resolves the popup page, or null for a matching URL in the original page.
export async function popupOrNavigation(page, pattern, action) {
  const failure = (code, state) =>
    Object.assign(
      new Error(
        `page ${state} before provider handoff completed; last URL ${page.url()}`,
      ),
      { code, pageUrl: page.url() },
    );
  if (page.isClosed()) throw failure('PAGE_CLOSED', 'closed');
  const alreadyMatched = matchesUrl(pattern, page.url());
  const { promise, resolve, reject } = Promise.withResolvers();
  const onPopup = (popup) => resolve(popup);
  const onNavigated = (frame) => {
    try {
      if (frame === page.mainFrame() && matchesUrl(pattern, frame.url()))
        resolve(null);
    } catch (error) {
      reject(error);
    }
  };
  const onClose = () => reject(failure('PAGE_CLOSED', 'closed'));
  const onCrash = () => reject(failure('PAGE_CRASHED', 'crashed'));
  page.once('popup', onPopup);
  page.on('framenavigated', onNavigated);
  page.once('close', onClose);
  page.once('crash', onCrash);
  try {
    if (alreadyMatched) resolve(null);
    const actionResult = Promise.resolve()
      .then(() => action())
      .catch((error) => {
        reject(error);
        throw error;
      });
    const [surface, performed] = await Promise.allSettled([
      promise,
      actionResult,
    ]);
    if (performed.status === 'rejected') throw performed.reason;
    if (surface.status === 'rejected') throw surface.reason;
    return surface.value;
  } finally {
    page.off('popup', onPopup);
    page.off('framenavigated', onNavigated);
    page.off('close', onClose);
    page.off('crash', onCrash);
  }
}

// A form submit is answered either by the page leaving the form's URL (`stays`
// uses the same pattern contract as urlMatching) or by the page's own
// message (`message`, a locator) becoming visible. Resolves 'navigated' or
// 'message' once the answer has come and the page has settled.
export async function submitAnswered(page, stays, message) {
  for (;;) {
    const answer = await readAcrossNavigation(page, async () => {
      if (!matchesUrl(stays, page.url())) return 'navigated';
      if (await message.isVisible()) return 'message';
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(resolve)),
      );
      return null;
    });
    if (answer && answer !== DOCUMENT_REPLACED) {
      await pageSettled(page);
      return answer;
    }
  }
}

// Correlates an action's first matching new request with its own response.
// The caller owns this page's action; unrelated and already-running requests
// cannot satisfy it. Network failure, closure and crash are terminal outcomes.
export async function responseAfterAction(page, matches, action) {
  let request;
  const failure = (code, message) =>
    Object.assign(new Error(message), {
      code,
      requestMethod: request?.method() ?? null,
      requestUrl: request?.url() ?? null,
      pageUrl: page.url(),
    });
  if (page.isClosed())
    throw failure(
      'PAGE_CLOSED',
      'page is already closed before the request action',
    );
  const { promise, resolve, reject } = Promise.withResolvers();
  const describe = () =>
    request ? `${request.method()} ${request.url()}` : 'a matching request';
  const onRequest = (candidate) => {
    try {
      if (!request && matches(candidate)) request = candidate;
    } catch (error) {
      reject(error);
    }
  };
  const onResponse = (response) => {
    if (response.request() === request) resolve(response);
  };
  const onRequestFailed = (failed) => {
    if (failed !== request) return;
    const errorText = failed.failure()?.errorText ?? null;
    reject(
      Object.assign(
        failure(
          'REQUEST_FAILED',
          `request failed: ${describe()}; ${errorText ?? 'the browser supplied no failure detail'}`,
        ),
        { errorText },
      ),
    );
  };
  const onClose = () =>
    reject(
      failure(
        'PAGE_CLOSED',
        `page closed before ${describe()} responded; last URL ${page.url()}`,
      ),
    );
  const onCrash = () =>
    reject(
      failure(
        'PAGE_CRASHED',
        `page crashed before ${describe()} responded; last URL ${page.url()}`,
      ),
    );
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  page.once('close', onClose);
  page.once('crash', onCrash);
  try {
    const actionResult = Promise.resolve()
      .then(() => action())
      .catch((error) => {
        reject(error);
        throw error;
      });
    const [response, performed] = await Promise.allSettled([
      promise,
      actionResult,
    ]);
    if (performed.status === 'rejected') throw performed.reason;
    if (response.status === 'rejected') throw response.reason;
    return response.value;
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
    page.off('close', onClose);
    page.off('crash', onCrash);
  }
}

// Operator review has an observable end, not an unresolved promise.
export async function reviewUntilClosed(session) {
  const { page, ctx } = session;
  if (page.isClosed()) return;
  const { promise, resolve, reject } = Promise.withResolvers();
  const onClose = () => resolve();
  const onCrash = () =>
    reject(
      Object.assign(new Error('page crashed during operator review'), {
        code: 'PAGE_CRASHED',
        operation: 'operator_review',
        pageUrl: page.url(),
      }),
    );
  page.on('close', onClose);
  page.on('crash', onCrash);
  ctx.on('close', onClose);
  process.on('SIGINT', onClose);
  process.on('SIGTERM', onClose);
  try {
    await promise;
  } finally {
    page.off('close', onClose);
    page.off('crash', onCrash);
    ctx.off('close', onClose);
    process.off('SIGINT', onClose);
    process.off('SIGTERM', onClose);
  }
}
