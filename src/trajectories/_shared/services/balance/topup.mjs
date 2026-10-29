// One service's top-up: the stated amount and confirmation (topupOpts), the
// service's sign-in (./run.mjs: googleSignIn or formSignIn, or its own), its
// funds page, the amount typed into the page's amount field and read back,
// then its pay button. A funds page without an amount field, or one that
// does not keep the stated amount, is refused before anything is charged:
// a top-up never pays whatever amount the page happened to preselect.
import { WSession } from '../../../../../dist/session/wsession.js';
import { pageSettled } from '../../page/settled.mjs';
import { findAndClickPayButton, topupOpts } from '../topup_common.mjs';

/**
 * @param {object} run
 * @param {string} run.label     the run's label and its errors' code prefix
 * @param {(s: object, code: string) => Promise<void>} run.signIn signs the session in
 * @param {string} run.fundsUrl  the service's page for adding funds
 * @param {(s: object) => Promise<void>} [run.clearPage] closes what the funds page lays over its form (a survey, an onboarding popup)
 */
export async function runTopup(run) {
  const { usd } = topupOpts();
  const code = run.label.toUpperCase();
  const s = await WSession.start({ label: run.label, browser: 'chromium' });
  try {
    await run.signIn(s, code);
    const response = await s.page.goto(run.fundsUrl, {
      waitUntil: 'domcontentloaded',
    });
    if (!response)
      throw new Error(
        `${code}_FUNDS_PAGE_UNANSWERED: ${run.fundsUrl}; nothing was charged`,
      );
    if (!response.ok())
      throw new Error(
        `${code}_FUNDS_PAGE_HTTP_ERROR: HTTP ${response.status()} at ${response.url()}; nothing was charged`,
      );
    await pageSettled(s.page);
    if (run.clearPage) await run.clearPage(s);
    const amount = s.page
      .locator(
        'input[type="number"], input[name*="amount" i], input[inputmode="numeric"]',
      )
      .filter({ visible: true })
      .first();
    if (!(await amount.isVisible()))
      throw new Error(
        `${code}_AMOUNT_FIELD_ABSENT: ${s.page.url()} shows no amount field for $${usd}; nothing was charged`,
      );
    await amount.click();
    await amount.fill(String(usd));
    const kept = await amount.inputValue();
    if (Number(kept) !== usd)
      throw new Error(
        `${code}_AMOUNT_NOT_KEPT: the amount field holds "${kept}", not ${usd}; nothing was charged`,
      );
    console.log(`[trajectory] amount filled: $${usd}`);
    if (!(await findAndClickPayButton(s.page)))
      throw new Error(
        `${code}_PAY_CONTROL_ABSENT: ${s.page.url()} offers no pay or checkout button; nothing was charged`,
      );
    await pageSettled(s.page);
    console.log(
      `PASS-CHARGED-PENDING: checkout opened for $${usd} at ${s.page.url()}; the charge completes there and the provider's balance reads the result`,
    );
  } finally {
    await s.close();
  }
}
