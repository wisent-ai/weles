import { pageSettled } from '../../../_shared/page/settled.mjs';

// A rejection is superseded only by observed main-frame browser activity,
// never by matching the error's wording.
export async function gotoAuthorize(page, authorizeUrl, mark) {
  let firstRequest;
  let replacementRequested = false;
  let navigated = false;
  const onRequest = (request) => {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame())
      return;
    if (firstRequest) replacementRequested = true;
    else firstRequest = request;
  };
  const onNavigated = (frame) => {
    if (frame === page.mainFrame()) navigated = true;
  };
  page.on('request', onRequest);
  page.on('framenavigated', onNavigated);
  try {
    await page.goto(authorizeUrl, { waitUntil: 'commit' });
  } catch (error) {
    // Drain events already queued with the rejection before deciding whether
    // a replacement exists. Never turn an unobserved replacement into success.
    if (!navigated && !page.isClosed())
      await new Promise((resolve) => setImmediate(resolve));
    if (page.isClosed() || (!navigated && !replacementRequested)) throw error;
    if (!navigated) {
      await page.waitForEvent('framenavigated', {
        predicate: (frame) => frame === page.mainFrame(),
      });
    }
    await pageSettled(page);
    mark('authorize_redirected');
    const requested = new URL(authorizeUrl);
    const landed = new URL(page.url());
    console.log(
      `[google_sso] ${requested.origin}${requested.pathname} was replaced by a navigation; the browser landed on ${landed.origin}${landed.pathname}`,
    );
    return;
  } finally {
    page.off('request', onRequest);
    page.off('framenavigated', onNavigated);
  }
  await pageSettled(page);
}
