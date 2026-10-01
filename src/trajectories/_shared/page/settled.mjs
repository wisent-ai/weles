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

export async function pageSettled(page) {
  await page.waitForLoadState('load');
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers();
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
    return promise;
  });
}

export async function pageCondition(page, predicate, arg) {
  const handle = await page.waitForFunction(predicate, arg, { polling: 'raf' });
  return handle.jsonValue();
}

// Waits until the page URL matches `pattern` and returns it.
export async function urlMatching(page, pattern) {
  await page.waitForURL(pattern);
  return page.url();
}
