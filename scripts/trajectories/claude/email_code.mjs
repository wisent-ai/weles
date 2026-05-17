// claude.ai email-code login. The ONLY fully-automated auth path:
// Google SSO is bot-blocked and these accounts have no claude.ai
// password. claude.ai emails a 5-6 digit code to the @wisentmedia.com
// address; s.checkEmail reads it from Resend receiving (the only inbox
// the infra can read). First run creates the account on that email;
// later runs re-auth the same one.
export async function doEmailCode({
  s, login, authorizeUrl, mark,
  humanFill, humanType, humanClickLocator, humanIdlePause, pageDiag,
}) {
  mark('goto_authorize');
  await s.goto(authorizeUrl);
  await humanIdlePause('deliberate');

  mark('email_enter');
  const emIn = s.page.locator('input[type="email"], input[name="email"], input[autocomplete="email"], input[id*="email" i]').filter({ visible: true }).first();
  await emIn.waitFor({ state: 'visible' });
  await humanFill(s.page, emIn, login.email);
  await humanType(s.page, '\n');
  await humanClickLocator(s.page, s.page.locator('button:has-text("Continue"), button[type="submit"]').filter({ visible: true }).first());
  await humanIdlePause('long');

  mark('email_code_poll');
  let code = '';
  for (let i = 0; i < 24; i++) {
    code = await s.checkEmail(login.email, 'anthropic');
    if (/^\d{5,6}$/.test(code)) break;
    await humanIdlePause('long');
  }
  if (!/^\d{5,6}$/.test(code)) {
    console.log(`FAIL: no claude.ai email code after polling (last="${code}"). ${await pageDiag(s.page)}`);
    process.exit(1);
  }
  console.log(`[claude-login] got email code (len=${code.length})`);

  mark('email_code_enter');
  const cIn = s.page.locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"], input[id*="code" i], input[id*="otp" i]').filter({ visible: true }).first();
  await cIn.waitFor({ state: 'visible' });
  await humanFill(s.page, cIn, code);
  await humanType(s.page, '\n');
  await humanClickLocator(s.page, s.page.locator('button[type="submit"], button:has-text("Verify"), button:has-text("Continue"), button:has-text("Log in")').filter({ visible: true }).first());
  await humanIdlePause('long');
}
