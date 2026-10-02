// The provider's CreditCardPayment component loads Stripe.js, then redirects
// the created checkout session. Its caught console errors are real failures,
// not a reason to leave a URL observer pending forever.
export async function openStripeCheckout(page, createInvoice) {
  let sessionId;
  const failure = (code, message, details = {}) => Object.assign(new Error(message), {
    code, operation: 'juicysms_checkout_handoff', pageUrl: page.url(), ...details,
  });
  if (page.isClosed()) throw failure('PAGE_CLOSED', 'Checkout page is already closed');
  const { promise, resolve, reject } = Promise.withResolvers();
  const inspect = () => {
    try {
      if (!sessionId) return;
      const address = new URL(page.url());
      if (address.origin !== 'https://checkout.stripe.com') return;
      const observed = address.pathname.match(/^\/c\/pay\/([^/]+)\/?$/)?.[1];
      if (observed !== sessionId) {
        reject(failure('JUICYSMS_CHECKOUT_SESSION_MISMATCH', 'Stripe opened a different checkout session', {
          expectedSessionId: sessionId, observedSessionId: observed ?? null,
        }));
      } else resolve();
    } catch (error) { reject(error); }
  };
  const isLoader = (request) => {
    for (let current = request; current; current = current.redirectedFrom()) {
      if (current.url() === 'https://js.stripe.com/v3/') return true;
    }
    return false;
  };
  const onRequestFailed = request => {
    try {
      if (isLoader(request)) reject(failure('JUICYSMS_STRIPE_LOADER_FAILED', 'Stripe.js could not be loaded', {
        requestUrl: request.url(), errorText: request.failure()?.errorText ?? null,
      }));
    } catch (error) { reject(error); }
  };
  const onResponse = response => {
    try {
      if (response.status() >= 400 && isLoader(response.request())) {
        reject(failure('JUICYSMS_STRIPE_LOADER_HTTP_ERROR', 'Stripe.js returned an unsuccessful response', {
          requestUrl: response.url(), status: response.status(),
        }));
      }
    } catch (error) { reject(error); }
  };
  const onConsole = message => {
    try {
      if (message.type() !== 'error') return;
      const source = message.location().url;
      if (!source) return;
      const address = new URL(source);
      if (address.origin === 'https://juicysms.com' && /^\/build\/assets\/CreditCardPayment-[^/]+\.js$/.test(address.pathname)) {
        reject(failure('JUICYSMS_STRIPE_HANDOFF_FAILED', 'JuicySMS reported a Stripe handoff error', {
          sourceUrl: source, providerError: message.text(),
        }));
      }
    } catch (error) { reject(error); }
  };
  const onNavigated = frame => { if (frame === page.mainFrame()) inspect(); };
  const onClose = () => reject(failure('PAGE_CLOSED', 'Page closed before the checkout handoff completed'));
  const onCrash = () => reject(failure('PAGE_CRASHED', 'Page crashed before the checkout handoff completed'));
  page.on('framenavigated', onNavigated);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);
  page.on('console', onConsole);
  page.once('close', onClose);
  page.once('crash', onCrash);
  try {
    const created = Promise.resolve().then(createInvoice).then(value => {
      if (typeof value !== 'string' || !/^cs_live_[A-Za-z0-9]+$/.test(value)) {
        throw failure('JUICYSMS_CHECKOUT_SESSION_INVALID', 'JuicySMS did not return a live Stripe checkout identifier');
      }
      sessionId = value;
      inspect();
      return value;
    }).catch(error => { reject(error); throw error; });
    const [observed, invoice] = await Promise.allSettled([promise, created]);
    if (invoice.status === 'rejected') throw invoice.reason;
    if (observed.status === 'rejected') throw observed.reason;
    return invoice.value;
  } finally {
    page.off('framenavigated', onNavigated);
    page.off('requestfailed', onRequestFailed);
    page.off('response', onResponse);
    page.off('console', onConsole);
    page.off('close', onClose);
    page.off('crash', onCrash);
  }
}
