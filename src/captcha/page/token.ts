// Handing a solved token to the page: every frame's response fields for the
// provider are filled, and every callback the provider's widget registered
// is called with it. A frame that cannot be asked, and a callback that
// throws, is named in the log rather than read as "not accepted".
import type { Frame, Page } from 'playwright';

export type TokenProvider = 'recaptcha' | 'turnstile' | 'hcaptcha';

/** The response fields each provider's widget submits its token in. */
const TOKEN_FIELDS: Readonly<Record<TokenProvider, readonly string[]>> =
  Object.freeze({
    recaptcha: [
      '#g-recaptcha-response',
      'textarea[name="g-recaptcha-response"]',
    ],
    turnstile: [
      'input[name="cf-turnstile-response"]',
      'textarea[name="cf-turnstile-response"]',
      '.cf-turnstile-response',
    ],
    // hCaptcha submits its token as h-captcha-response and, for sites built
    // on reCAPTCHA's form handling, also as g-recaptcha-response
    // (https://docs.hcaptcha.com/#add-the-hcaptcha-widget-to-your-webpage).
    hcaptcha: [
      'textarea[name="h-captcha-response"]',
      'textarea[name="g-recaptcha-response"]',
    ],
  });

type PageDelivery = {
  fields: boolean;
  callbacks: boolean;
  failedCallbacks: string[];
};

type TokenField = HTMLInputElement | HTMLTextAreaElement;

type FrameDelivery =
  | ({ url: string } & PageDelivery)
  | { url: string; unreachable: string };

/** Runs in the page: fill the fields, then call every registered token callback. */
function deliverInPage({
  selectors,
  token,
}: {
  selectors: readonly string[];
  token: string;
}): PageDelivery {
  let fields = false;
  for (const selector of selectors) {
    for (const element of Array.from(
      document.querySelectorAll<TokenField>(selector),
    )) {
      element.value = token;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      fields = true;
    }
  }
  let callbacks = false;
  const failedCallbacks: string[] = [];
  const callbackKey =
    /(^|[-_])(callback|promise-callback|expired-callback|error-callback)$/i;
  // `seen` ends every cycle, so the walk covers the whole client object
  // however deep the provider nests its callbacks.
  const visit = (value: unknown, seen: Set<unknown>): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== 'function') {
        visit(entry, seen);
        continue;
      }
      if (!callbackKey.test(key)) continue;
      try {
        (entry as (token: string) => void)(token);
        callbacks = true;
      } catch (error) {
        failedCallbacks.push(`${key}: ${String(error)}`);
      }
    }
  };
  const registry = window as unknown as Record<
    string,
    { clients?: unknown } | undefined
  >;
  visit(registry.___grecaptcha_cfg?.clients, new Set<unknown>());
  visit(registry.___turnstile_cfg?.clients, new Set<unknown>());
  return { fields, callbacks, failedCallbacks };
}

async function deliverInFrame(
  frame: Frame,
  selectors: readonly string[],
  token: string,
): Promise<FrameDelivery> {
  const url = frame.url();
  let delivery: FrameDelivery;
  try {
    delivery = {
      url,
      ...(await frame.evaluate(deliverInPage, { selectors, token })),
    };
  } catch (error) {
    delivery = {
      url,
      unreachable: error instanceof Error ? error.message : String(error),
    };
  }
  return delivery;
}

/**
 * Give `token` to every frame of `page`; true when some field or callback
 * took it. Frames that could not be asked and callbacks that threw are
 * logged with their causes.
 */
export async function deliverCaptchaToken(
  page: Page,
  provider: TokenProvider,
  token: string,
): Promise<boolean> {
  const deliveries: FrameDelivery[] = [];
  for (const frame of page.frames())
    deliveries.push(await deliverInFrame(frame, TOKEN_FIELDS[provider], token));
  const problems = deliveries.flatMap((delivery) =>
    'unreachable' in delivery
      ? [`frame ${delivery.url} could not be asked: ${delivery.unreachable}`]
      : delivery.failedCallbacks.map(
          (failure) => `frame ${delivery.url} callback ${failure}`,
        ),
  );
  for (const problem of problems) console.log(`[captcha] ${problem}`);
  const accepted = deliveries.some(
    (delivery) =>
      !('unreachable' in delivery) && (delivery.fields || delivery.callbacks),
  );
  if (!accepted)
    console.log(
      `[captcha] ${provider} token solved but no page field or callback in ${deliveries.length} frames accepted it`,
    );
  return accepted;
}
