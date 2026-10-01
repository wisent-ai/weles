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

// Runs inside the page: resolves once the document has loaded and its DOM has
// gone two consecutive animation frames without a mutation.
function settleInPage() {
  const { promise, resolve } = Promise.withResolvers();
  const quiet = () => {
    let changed = true;
    let quietFrames = 0;
    const observer = new MutationObserver(() => { changed = true; });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
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

const DOCUMENT_REPLACED = /Execution context was destroyed/i;

export async function pageSettled(page) {
  // Both the load and the quiet DOM are awaited inside the page, so no
  // Playwright default limit applies — the page alone decides when it is done.
  // When a navigation replaces the document mid-wait, the new document is the
  // one that has to settle, so the wait moves to it; any other failure is the
  // caller's error.
  for (;;) {
    try {
      await page.evaluate(settleInPage);
      return;
    } catch (error) {
      if (!DOCUMENT_REPLACED.test(String(error?.message))) throw error;
    }
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

// Waits until the main frame's URL matches `pattern` (a RegExp, a predicate
// over the URL, or text the URL must contain) and returns it. It listens to
// the page's own navigations, so it ends when the page gets there, not on a
// clock.
export async function urlMatching(page, pattern) {
  const matches = (url) => {
    if (pattern instanceof RegExp) return pattern.test(url);
    if (typeof pattern === 'function') return pattern(url);
    return url.includes(pattern);
  };
  if (matches(page.url())) return page.url();
  const { promise, resolve, reject } = Promise.withResolvers();
  const onNavigated = (frame) => {
    if (frame !== page.mainFrame() || !matches(frame.url())) return;
    resolve(frame.url());
  };
  const onClose = () => reject(new Error(`page closed before its URL matched ${pattern}; last URL ${page.url()}`));
  const onCrash = () => reject(new Error(`page crashed before its URL matched ${pattern}; last URL ${page.url()}`));
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

// A click that opens a provider either in a popup or in the same tab: call
// this BEFORE the click; it resolves the popup page, or null once the page's
// own URL matches `pattern` (a RegExp, or text the URL must contain).
export function popupOrNavigation(page, pattern) {
  return Promise.any([page.waitForEvent('popup'), urlMatching(page, pattern).then(() => null)]);
}

// A form submit is answered either by the page leaving the form's URL (`stays`
// is a RegExp that matches while the form is shown) or by the page's own
// message (`message`, a locator) becoming visible. Resolves 'navigated' or
// 'message' once the answer has come and the page has settled.
export async function submitAnswered(page, stays, message) {
  const answer = await Promise.any([
    urlMatching(page, (url) => !stays.test(url)).then(() => 'navigated'),
    message.waitFor({ state: 'visible' }).then(() => 'message'),
  ]);
  await pageSettled(page);
  return answer;
}

// Correlates an action's first matching new request with its own response.
// The caller owns this page's action; unrelated and already-running requests
// cannot satisfy it. Network failure, closure and crash are terminal outcomes.
export async function responseAfterAction(page, matches, action) {
  let request;
  const failure = (code, message) => Object.assign(new Error(message), {
    code,
    requestMethod: request?.method() ?? null,
    requestUrl: request?.url() ?? null,
    pageUrl: page.url(),
  });
  if (page.isClosed()) throw failure('PAGE_CLOSED', 'page is already closed before the request action');
  const { promise, resolve, reject } = Promise.withResolvers();
  const describe = () => request ? `${request.method()} ${request.url()}` : 'a matching request';
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
    reject(Object.assign(failure('REQUEST_FAILED', `request failed: ${describe()}; ${errorText ?? 'the browser supplied no failure detail'}`), { errorText }));
  };
  const onClose = () => reject(failure('PAGE_CLOSED', `page closed before ${describe()} responded; last URL ${page.url()}`));
  const onCrash = () => reject(failure('PAGE_CRASHED', `page crashed before ${describe()} responded; last URL ${page.url()}`));
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  page.once('close', onClose);
  page.once('crash', onCrash);
  try {
    const actionResult = Promise.resolve().then(action).catch((error) => {
      reject(error);
      throw error;
    });
    const [response, performed] = await Promise.allSettled([promise, actionResult]);
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
