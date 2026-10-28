// The JuicySMS side of a top-up, up to the Stripe checkout it opens: the
// signed-in account is the one asked for, the form is in USD and its terms
// are accepted, the card method and the exact amount are entered, and the
// deposit request JuicySMS sends carries that method and amount.
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import {
  responseAfterAction,
  urlMatching,
} from '../../_shared/page/settled.mjs';
import { openJuicyPage, readJuicyPage } from '../page.mjs';
import { openStripeCheckout } from '../checkout.mjs';
import { failure } from './failure.mjs';

/** Submit a card deposit of `usd` for `login`'s account and answer the Stripe checkout session it opened. */
export async function openCardDeposit(s, login, usd) {
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
      { expectedAccount: login.email, observedAccount: accountEmail },
    );
  }
  if (funds.currency?.code !== 'USD')
    throw failure(
      'JUICYSMS_TOPUP_CURRENCY_MISMATCH',
      'TOPUP_USD requires a provider form denominated in USD',
      { expectedCurrency: 'USD', observedCurrency: funds.currency?.code },
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
  return openStripeCheckout(s.page, async () => {
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
          observedAmount: submitted?.amount,
          observedMethod: submitted?.pMethod,
        },
      );
    }
    return (await readJuicyPage(response, 'CreditCardPayment')).pid;
  });
}
