// Waiting for a page to finish what a navigation or a click started, measured
// by the page itself instead of a clock: the document has loaded and its DOM
// has gone two consecutive animation frames without a mutation. A page that
// keeps changing keeps the wait open; the run's cancellation ends it.
//
// This is the core (TypeScript) counterpart of
// src/trajectories/_shared/page/settled.mjs, for modules compiled into dist.
export type EvaluatingPage = { evaluate: (...args: any[]) => Promise<unknown> };

// Runs inside the page.
function settleInPage(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
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

const DOCUMENT_REPLACED = /Execution context was destroyed|navigation/i;

export async function pageSettled(page: EvaluatingPage): Promise<void> {
  // When a navigation replaces the document mid-wait, the new document is the
  // one that has to settle; any other failure is the caller's error.
  for (;;) {
    try {
      await page.evaluate(settleInPage);
      return;
    } catch (error) {
      if (!DOCUMENT_REPLACED.test(String((error as Error)?.message))) throw error;
    }
  }
}
