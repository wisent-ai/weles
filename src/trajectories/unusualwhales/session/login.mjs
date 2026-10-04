// Signing in to Unusual Whales, shared by every script in this directory.
//
// The form is waited for until its password field exists, and the submit is
// answered either by the page leaving /login or by the form's own alert; the
// alert's text is the failure. Nothing here gives up on a count: the page
// decides when it is ready, and the run's cancellation ends a page that never
// answers.

import { pageCondition, pageSettled, submitAnswered } from '../../_shared/page/settled.mjs';

export async function loginUnusualWhales(session, email, password) {
  const page = session.page;
  await session.goto('https://unusualwhales.com/login');
  await pageCondition(page, () => document.querySelector('input[type="password"]') !== null);
  const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input'))
    .map((input) => ({ name: input.name, type: input.type, ph: input.placeholder })));
  const emailInput = inputs.find((input) => input.type === 'email' || input.name === 'email' || /email|address/i.test(input.ph || ''));
  const passwordInput = inputs.find((input) => input.type === 'password' || input.name === 'password');
  if (!emailInput) throw new Error(`unusualwhales login form has no email field: ${JSON.stringify(inputs)}`);
  const selector = (input) => (input.name ? `input[name="${input.name}"]` : `input[placeholder="${input.ph}"]`);
  await session.fillSelector(selector(emailInput), email); await pageSettled(page);
  await session.fillSelector(selector(passwordInput), password); await pageSettled(page);
  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  if (await submit.count()) await submit.click();
  else await page.evaluate(() => document.querySelector('form')?.requestSubmit());
  const alert = page.locator('[role="alert"]').filter({ visible: true }).first();
  if (await submitAnswered(page, '/login', alert) === 'message') {
    throw new Error(`unusualwhales login refused: ${(await alert.innerText()).trim()}`);
  }
}
