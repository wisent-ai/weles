// JuicySMS top-up: an owned checkout and a provider receipt, never a URL-only PASS.
import { WSession } from '../../../dist/session/wsession.js';
import {
  googleSso,
  getGoogleSsoCreds,
} from '../_shared/services/google_sso.mjs';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';
import {
  pageCondition,
  pageSettled,
  popupOrNavigation,
  responseAfterAction,
  urlMatching,
} from '../_shared/page/settled.mjs';
import {
  openOperatorRequest,
  closeOperatorRequest,
} from '../../operator/request.mjs';
import { openJuicyPage, readJuicyPage } from './page.mjs';
import { openStripeCheckout } from './checkout.mjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOutputPath } from '#run-output';

const failure = (code, message, details = {}) =>
  Object.assign(new Error(message), { code, ...details });
const { usd } = topupOpts();
const requestedCents = Math.round(usd * 100);
if (!Number.isSafeInteger(requestedCents) || Number(usd.toFixed(2)) !== usd) {
  throw failure(
    'JUICYSMS_AMOUNT_UNREPRESENTABLE',
    'TOPUP_USD must be representable as whole USD cents',
    { requestedUsd: usd },
  );
}
const card = {
  num: process.env.TOPUP_CARD_NUMBER ?? '',
  exp: process.env.TOPUP_CARD_EXP ?? '',
  cvc: process.env.TOPUP_CARD_CVC ?? '',
  zip: process.env.TOPUP_CARD_ZIP ?? '',
  name: process.env.TOPUP_CARD_NAME ?? '',
};
if (!card.num || !card.exp || !card.cvc)
  throw failure(
    'JUICYSMS_CARD_UNAVAILABLE',
    'TOPUP_CARD_NUMBER, TOPUP_CARD_EXP and TOPUP_CARD_CVC are required before opening checkout',
    {
      missingNumber: !card.num,
      missingExpiry: !card.exp,
      missingCvc: !card.cvc,
    },
  );
const login = await getGoogleSsoCreds();
if (!login)
  throw failure(
    'JUICYSMS_IDENTITY_UNAVAILABLE',
    'No Google SSO credentials are available',
  );
const run = `juicysms_topup:${randomUUID()}`;
const output = runOutputPath(
  'juicysms_topup',
  run.slice('juicysms_topup:'.length),
);
mkdirSync(output, { recursive: true });
const s = await WSession.start({
  label: 'juicysms_topup',
  browser: 'chromium',
});
let approval;
let receipt;
let providerReceipt;
let approvalDetail = 'Provider payment completion was not observed.';
let paymentResponse;
let paymentObservation;
let paymentStopping = false;

async function fillCardField(name, value, numeric = false, optional = false) {
  const field = s.page
    .locator(`input[name="${name}"], input#${name}`)
    .filter({ visible: true })
    .first();
  if (optional && !(await field.isVisible())) return;
  await field.waitFor({ state: 'visible' });
  if (!(await field.isEditable()))
    throw failure(
      'JUICYSMS_CARD_FIELD_NOT_EDITABLE',
      'Checkout field is not editable',
      { field: name },
    );
  await humanFill(s.page, field, value);
  await s.page.keyboard.press('Tab');
  const observed = await field.inputValue();
  const expected = numeric ? value.replace(/\D/g, '') : value.trim();
  const actual = numeric ? observed.replace(/\D/g, '') : observed.trim();
  if (actual !== expected)
    throw failure(
      'JUICYSMS_CARD_INPUT_MISMATCH',
      'Checkout input did not retain the supplied value',
      {
        field: name,
        expectedLength: expected.length,
        observedLength: actual.length,
      },
    );
}

// One frame-driven observation: no competing URL and iframe waiters.
function checkoutState(observeVerification) {
  const address = new URL(location.href);
  const path = address.pathname.replace(/\/$/, '');
  if (
    address.origin === 'https://juicysms.com' &&
    (path === '/payments/success' || path === '/payments/failed')
  ) {
    return { kind: 'returned', path };
  }
  if (address.origin !== 'https://checkout.stripe.com') return false;
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.right > 0 &&
      box.bottom > 0 &&
      box.left < innerWidth &&
      box.top < innerHeight &&
      style.visibility === 'visible' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  };
  if (observeVerification) {
    const frame = [
      ...document.querySelectorAll(
        'iframe[src*="3d_secure"], iframe[name*="3ds" i], iframe[src^="https://hooks.stripe.com/"]',
      ),
    ].find(visible);
    if (frame) return { kind: 'verification' };
  }
  const invalid = [
    ...document.querySelectorAll('input[aria-invalid="true"]'),
  ].find(visible);
  if (invalid)
    return { kind: 'input_refused', field: invalid.name || invalid.id || null };
  return false;
}

try {
  await openJuicyPage(s, 'https://juicysms.com/login');
  const googleButton = s.page
    .locator(
      'a:has-text("LOGIN WITH GOOGLE"), button:has-text("LOGIN WITH GOOGLE"), a:has-text("Login with Google"), button:has-text("Login with Google")',
    )
    .and(s.page.locator(':not(:disabled):not([aria-disabled="true"])'))
    .filter({ visible: true })
    .first();
  await googleButton.waitFor({ state: 'visible' });
  const popup = await popupOrNavigation(s.page, /accounts\.google\.com/, () =>
    humanClickLocator(s.page, googleButton),
  );
  if (
    !(await googleSso(s, login, {
      originHost: 'juicysms.com',
      page: popup ?? undefined,
    }))
  ) {
    throw failure('JUICYSMS_SIGN_IN_INCOMPLETE', 'Google SSO did not complete');
  }
  await urlMatching(s.page, /^https:\/\/(www\.)?juicysms\.com\/(?!login)/);
  const funds = await readJuicyPage(
    await openJuicyPage(s, 'https://juicysms.com/addfunds'),
    'AddFunds',
  );
  const accountEmail = funds.auth?.user?.email;
  if (
    typeof accountEmail !== 'string' ||
    accountEmail.trim().toLowerCase() !== login.email.trim().toLowerCase()
  ) {
    throw failure(
      'JUICYSMS_ACCOUNT_MISMATCH',
      'JuicySMS account does not match the selected sign-in identity',
      {
        expectedAccount: login.email,
        observedAccount: accountEmail ?? null,
      },
    );
  }
  if (funds.currency?.code !== 'USD')
    throw failure(
      'JUICYSMS_TOPUP_CURRENCY_MISMATCH',
      'TOPUP_USD requires a provider form denominated in USD',
      {
        expectedCurrency: 'USD',
        observedCurrency: funds.currency?.code ?? null,
      },
    );
  if (funds.acceptedtos !== true)
    throw failure(
      'JUICYSMS_TERMS_REQUIRED',
      'JuicySMS requires the account owner to accept its terms; payment consent does not accept them',
    );
  const form = s.page.locator('#addfundsform');
  await form.waitFor({ state: 'visible' });
  const cardMethod = form.getByRole('button', {
    name: 'Credit Card',
    exact: true,
  });
  if (!(await cardMethod.isEnabled()))
    throw failure(
      'JUICYSMS_CARD_METHOD_DISABLED',
      'JuicySMS credit-card payment is disabled',
    );
  await humanClickLocator(s.page, cardMethod);
  const amount = form.locator('input[type="number"]');
  if (!(await amount.isEditable()))
    throw failure(
      'JUICYSMS_AMOUNT_NOT_EDITABLE',
      'JuicySMS amount input is not editable',
    );
  await humanFill(s.page, amount, String(usd));
  await s.page.keyboard.press('Tab');
  const entered = await amount.evaluate((input) => ({
    value: input.value,
    valid: input.validity.valid,
    message: input.validationMessage,
  }));
  if (!entered.valid || Number(entered.value) !== usd)
    throw failure(
      'JUICYSMS_AMOUNT_REFUSED',
      'JuicySMS amount input did not accept the requested USD amount',
      {
        requestedUsd: usd,
        observedValue: entered.value,
        validationMessage: entered.message,
      },
    );
  const addFunds = form.locator('button[type="submit"]');
  if (!(await addFunds.isEnabled()))
    throw failure(
      'JUICYSMS_DEPOSIT_CONTROL_DISABLED',
      'JuicySMS deposit submission is not enabled',
    );
  const sessionId = await openStripeCheckout(s.page, async () => {
    const response = await responseAfterAction(
      s.page,
      (request) => {
        const address = new URL(request.url());
        return (
          request.method() === 'POST' &&
          address.origin === 'https://juicysms.com' &&
          address.pathname === '/addfunds'
        );
      },
      () => humanClickLocator(s.page, addFunds),
    );
    const submitted = response.request().postDataJSON();
    if (submitted?.pMethod !== 'CC' || Number(submitted?.amount) !== usd) {
      throw failure(
        'JUICYSMS_DEPOSIT_REQUEST_MISMATCH',
        'JuicySMS submitted a different amount or payment method; card payment was not dispatched',
        {
          requestedUsd: usd,
          observedAmount: submitted?.amount ?? null,
          observedMethod: submitted?.pMethod ?? null,
        },
      );
    }
    return (await readJuicyPage(response, 'CreditCardPayment')).pid;
  });
  const attemptPath = join(output, 'checkout_attempt.json');
  const attempt = {
    run,
    checkoutSessionId: sessionId,
    requestedUsd: usd,
    paymentDispatchStarted: false,
  };
  writeFileSync(attemptPath, JSON.stringify(attempt, null, 2));
  await pageSettled(s.page);
  await fillCardField('cardNumber', card.num, true);
  await fillCardField('cardExpiry', card.exp.replace(/\D/g, ''), true);
  await fillCardField('cardCvc', card.cvc, true);
  if (card.name) await fillCardField('billingName', card.name, false, true);
  if (card.zip) await fillCardField('billingPostalCode', card.zip, false, true);
  const pay = s.page
    .locator('button[type="submit"]:has-text("Pay")')
    .filter({ visible: true })
    .first();
  if (!(await pay.isEnabled()))
    throw failure(
      'JUICYSMS_CHECKOUT_SUBMIT_DISABLED',
      'Stripe checkout submission is not enabled',
    );
  const label = (await pay.innerText()).replace(/\s+/g, ' ').trim();
  const expectedLabel = `Pay ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(usd)}`;
  if (label !== expectedLabel)
    throw failure(
      'JUICYSMS_CHECKOUT_TOTAL_MISMATCH',
      'Stripe does not display the requested payment total',
      {
        expectedLabel,
        observedLabel: label,
      },
    );
  await s.screenshot('stripe_before_submit');
  attempt.paymentDispatchStarted = true;
  writeFileSync(attemptPath, JSON.stringify(attempt, null, 2));
  paymentResponse = responseAfterAction(
    s.page,
    (request) => {
      const address = new URL(request.url());
      return (
        request.method() === 'GET' &&
        request.isNavigationRequest() &&
        request.frame() === s.page.mainFrame() &&
        address.origin === 'https://juicysms.com' &&
        /^\/payments\/(success|failed)\/?$/.test(address.pathname)
      );
    },
    () => humanClickLocator(s.page, pay),
  );
  paymentObservation = (async () => {
    let state = await pageCondition(s.page, checkoutState, true);
    if (state.kind === 'verification') {
      await s.screenshot('stripe_verification');
      state = await pageCondition(s.page, checkoutState, true);
      if (state.kind === 'verification') {
        if (paymentStopping)
          throw failure(
            'JUICYSMS_PAYMENT_OBSERVATION_CANCELLED',
            'Payment observation stopped before an operator request could be opened',
          );
        const request = openOperatorRequest({
          kind: 'juicysms-payment-verification',
          account: login.email,
          run,
          instruction: `Complete the verification actually shown by the JuicySMS checkout or your bank for the requested USD ${usd} payment. Do not submit another payment.`,
        });
        if (request.run !== run || request.run_pid !== process.pid) {
          throw failure(
            'JUICYSMS_VERIFICATION_CONFLICT',
            "Another live run owns this account's verification request",
            { requestId: request.id },
          );
        }
        approval = request;
        console.log(
          `[topup] verification request ${request.id}; paging=${JSON.stringify(request.pages)}`,
        );
        state = await pageCondition(s.page, checkoutState, false);
      }
    }
    if (state.kind === 'input_refused')
      throw failure(
        'JUICYSMS_CHECKOUT_INPUT_REFUSED',
        'Stripe marks a checkout input invalid',
        { field: state.field },
      );
    return state;
  })();
  const [response, state] = await Promise.all([
    paymentResponse,
    paymentObservation,
  ]);
  if (state.path === '/payments/failed') {
    await readJuicyPage(response, 'PaymentFailed');
    providerReceipt = {
      ...attempt,
      paid: null,
      providerComponent: 'PaymentFailed',
      providerOutcome: 'failed_or_cancelled',
      providerUrl: response.url(),
    };
    writeFileSync(
      join(output, 'payment_receipt.json'),
      JSON.stringify(providerReceipt, null, 2),
    );
    throw failure(
      'JUICYSMS_PAYMENT_REFUSED',
      'JuicySMS reported payment failed or cancelled',
      { providerUrl: response.url(), checkoutSessionId: sessionId },
    );
  }
  const result = await readJuicyPage(response, 'PaymentSuccess');
  const observed = {
    ...attempt,
    orderKey: result.orderKey ?? null,
    paid: result.paid ?? null,
    value: result.value ?? null,
    currency: result.currency ?? null,
    providerUrl: response.url(),
  };
  providerReceipt = observed;
  const confirmed =
    result.paid === true &&
    typeof result.orderKey === 'string' &&
    result.orderKey.trim().length > 0;
  const receivedCents =
    typeof result.value === 'number' ? Math.round(result.value * 100) : NaN;
  const matchingTotal =
    result.currency === 'USD' &&
    Number.isSafeInteger(receivedCents) &&
    receivedCents === requestedCents;
  if (confirmed && matchingTotal) receipt = observed;
  writeFileSync(
    join(output, 'payment_receipt.json'),
    JSON.stringify(observed, null, 2),
  );
  if (!confirmed) {
    throw failure(
      'JUICYSMS_PAYMENT_UNCONFIRMED',
      'JuicySMS returned without a confirmed payment receipt; payment status must be checked before another attempt',
      observed,
    );
  }
  if (!matchingTotal) {
    throw failure(
      'JUICYSMS_PAYMENT_RECEIPT_MISMATCH',
      'JuicySMS confirmed a different amount or currency; do not submit another payment',
      observed,
    );
  }
  approvalDetail = `JuicySMS confirmed payment ${result.orderKey} for USD ${result.value}. This does not prove the balance was credited.`;
  console.log(
    `[topup] confirmed provider receipt=${join(output, 'payment_receipt.json')}; balance credit not asserted`,
  );
  await s.screenshot('stripe_post_submit');
} catch (error) {
  paymentStopping = true;
  approvalDetail = `${receipt ? 'JuicySMS confirmed the requested payment; ' : ''}${error.code ?? error.name}: ${error.message}`;
  console.error('FAIL:', error, {
    artifacts: output,
    providerReceipt: providerReceipt ?? null,
  });
  process.exitCode = 1;
} finally {
  paymentStopping = true;
  try {
    await s.close();
  } finally {
    await Promise.allSettled(
      [paymentResponse, paymentObservation].filter(Boolean),
    );
    if (approval)
      closeOperatorRequest(approval.id, Boolean(receipt), approvalDetail);
  }
}
if (receipt && !process.exitCode)
  console.log(
    `PASS-CHARGED: provider order=${receipt.orderKey} USD=${receipt.value}; balance credit not asserted; receipt=${join(output, 'payment_receipt.json')}`,
  );
