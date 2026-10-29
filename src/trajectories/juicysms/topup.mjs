// JuicySMS top-up: an owned checkout and a provider receipt, never a URL-only PASS.
import { WSession } from '../../../dist/session/wsession.js';
import { exitStatusFor } from '../../../dist/cli/usage.js';
import { getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import {
  loadTopupCardEnv,
  topupCard,
  topupOpts,
} from '../_shared/services/topup_common.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import {
  pageCondition,
  pageSettled,
  responseAfterAction,
} from '../_shared/page/settled.mjs';
import {
  openOperatorRequest,
  closeOperatorRequest,
} from '../../operator/request.mjs';
import { readJuicyPage, signInWithGoogle } from './page.mjs';
import { openCardDeposit } from './payment/deposit.mjs';
import { failure } from './payment/failure.mjs';
import { checkoutState } from './payment/checkout-state.mjs';
import { typeInto } from '../stripe/hosted_checkout.mjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOutputPath } from '#run-output';

const INDENT = '  ';
const writeJson = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, INDENT));
// US dollars as Stripe shows them, and the number of cent digits the
// currency has, so totals are compared in whole cents.
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});
const USD_DIGITS = USD.resolvedOptions().maximumFractionDigits;
const toCents = (dollars) => Math.round(dollars * Number(`1e${USD_DIGITS}`));

const { usd } = topupOpts();
const requestedCents = toCents(usd);
if (
  !Number.isSafeInteger(requestedCents) ||
  Number(usd.toFixed(USD_DIGITS)) !== usd
) {
  throw failure(
    'JUICYSMS_AMOUNT_UNREPRESENTABLE',
    'TOPUP_USD must be representable as whole USD cents',
    { requestedUsd: usd },
  );
}
// The card the workspace's card source holds; a missing number, expiry or
// CVC is refused by name before any page opens.
loadTopupCardEnv();
const card = topupCard();
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
const receiptPath = join(output, 'payment_receipt.json');
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

try {
  if (!(await signInWithGoogle(s, login)))
    throw failure('JUICYSMS_SIGN_IN_INCOMPLETE', 'Google SSO did not complete');
  const sessionId = await openCardDeposit(s, login, usd);
  const attemptPath = join(output, 'checkout_attempt.json');
  const attempt = {
    run,
    checkoutSessionId: sessionId,
    requestedUsd: usd,
    paymentDispatchStarted: false,
  };
  writeJson(attemptPath, attempt);
  await pageSettled(s.page);
  // The card's own fields must be on the page; name and postal code are
  // typed when the checkout asks for them.
  const required = async (field, value) => {
    const selector = `input[name="${field}"], input#${field}`;
    if (!(await typeInto(s.page, selector, value, true)))
      throw failure(
        'JUICYSMS_CARD_FIELD_MISSING',
        'The Stripe checkout shows no card field to type into',
        { field },
      );
  };
  await required('cardNumber', card.num);
  await required('cardExpiry', card.exp);
  await required('cardCvc', card.cvc);
  if (card.name)
    await typeInto(
      s.page,
      'input[name="billingName"], input#billingName',
      card.name,
      false,
    );
  if (card.zip)
    await typeInto(
      s.page,
      'input[name="billingPostalCode"], input#billingPostalCode',
      card.zip,
      false,
    );
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
  const expectedLabel = `Pay ${USD.format(usd)}`;
  if (label !== expectedLabel)
    throw failure(
      'JUICYSMS_CHECKOUT_TOTAL_MISMATCH',
      'Stripe does not display the requested payment total',
      { expectedLabel, observedLabel: label },
    );
  await s.screenshot('stripe_before_submit');
  attempt.paymentDispatchStarted = true;
  writeJson(attemptPath, attempt);
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
      providerComponent: 'PaymentFailed',
      providerOutcome: 'failed_or_cancelled',
      providerUrl: response.url(),
    };
    writeJson(receiptPath, providerReceipt);
    throw failure(
      'JUICYSMS_PAYMENT_REFUSED',
      'JuicySMS reported payment failed or cancelled',
      { providerUrl: response.url(), checkoutSessionId: sessionId },
    );
  }
  const result = await readJuicyPage(response, 'PaymentSuccess');
  // What JuicySMS's success page states; a field it leaves out stays out.
  const observed = {
    ...attempt,
    orderKey: result.orderKey,
    paid: result.paid,
    value: result.value,
    currency: result.currency,
    providerUrl: response.url(),
  };
  providerReceipt = observed;
  const confirmed =
    result.paid === true &&
    typeof result.orderKey === 'string' &&
    result.orderKey.trim() !== '';
  const matchingTotal =
    result.currency === 'USD' &&
    typeof result.value === 'number' &&
    toCents(result.value) === requestedCents;
  if (confirmed && matchingTotal) receipt = observed;
  writeJson(receiptPath, observed);
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
    `[topup] confirmed provider receipt=${receiptPath}; balance credit not asserted`,
  );
  await s.screenshot('stripe_post_submit');
} catch (error) {
  paymentStopping = true;
  const reached = receipt ? 'JuicySMS confirmed the requested payment; ' : '';
  approvalDetail = `${reached}${error.code ?? error.name}: ${error.message}`;
  console.error('FAIL:', error, { artifacts: output, providerReceipt });
  process.exitCode = exitStatusFor(error);
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
    `PASS-CHARGED: provider order=${receipt.orderKey} USD=${receipt.value}; balance credit not asserted; receipt=${receiptPath}`,
  );
