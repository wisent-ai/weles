// Catching the provider's redirect to a harness's own callback listener.
//
// A harness that started an authorization on another machine (`omp login`)
// listens for the redirect on its own loopback address, which the Weles
// browser cannot reach. The browser answers that one request itself and keeps
// the URL: it carries the authorization code and state the harness accepts
// pasted on its stdin, bound to the verifier only the harness holds.

import { constants as http } from 'node:http2';

/** Start catching requests to `redirectUri`; `captured` is the first URL. */
export async function captureRedirect(context, redirectUri) {
  let resolveCaptured;
  const captured = new Promise((resolve) => {
    resolveCaptured = resolve;
  });
  await context.route(
    (url) => url.href.startsWith(redirectUri),
    async (route) => {
      resolveCaptured(route.request().url());
      await route.fulfill({
        status: http.HTTP_STATUS_OK,
        contentType: 'text/plain',
        body: 'Weles caught this authorization for the harness that started it.',
      });
    },
  );
  return { captured };
}

/** The redirect_uri an authorize URL declares. */
export function declaredRedirect(authorizeUrl) {
  return new URL(authorizeUrl).searchParams.get('redirect_uri');
}
