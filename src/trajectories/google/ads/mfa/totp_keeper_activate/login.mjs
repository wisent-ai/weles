// Signing the keeper's browser into the Google Ads account, stored TOTP included.
import { generateTotp } from '../../../../_shared/services/google_sso.mjs';
import { EMAIL } from './settings.mjs';
import { clickText, fill, idle, nav, press, state } from './page.mjs';

export async function navigateStoredTotpChallenge(currentUrl) {
  if (!/accounts\.google\.com/.test(currentUrl || '') || !/signin\/challenge\/selection/.test(currentUrl || '')) return false;
  if (process.env.GOOGLE_SSO_ALLOW_DIRECT_TOTP !== '1') return false;
  const target = currentUrl.replace(/\/signin\/challenge\/selection(?=[?#])/, '/signin/challenge/totp');
  if (target === currentUrl) return false;
  const attempts = navigateStoredTotpChallenge.attempts || (navigateStoredTotpChallenge.attempts = new Set());
  const key = currentUrl.replace(/([?&](?:TL|rart|dsh)=)[^&]+/g, '$1');
  if (attempts.has(key)) return false;
  attempts.add(key);
  console.log('[google-ads-totp-keeper] opening Google Authenticator TOTP challenge directly');
  await nav(target);
  const next = await state();
  if (next.inputs.some((input) => input.visible && /totpPin|Pin|one-time-code|numeric|tel/i.test(`${input.name} ${input.autocomplete} ${input.type}`))) return true;
  await nav(currentUrl);
  return false;
}



export async function submitStoredGoogleCode(creds, offsetMs = 0) {
  if (!creds?.totpSecret) return false;
  const code = generateTotp(creds.totpSecret, offsetMs ? { now: Date.now() + offsetMs } : {});
  await fill('input[type="tel"], input[type="text"], input[inputmode="numeric"], input[name="totpPin"], input[name="Pin"]', code);
  await clickText(['Next', 'Verify', 'Done']).catch(async () => press('Enter'));
  return true;
}

export async function handleGoogleLogin(creds) {
  for (let step = 0; step < 40; step += 1) {
    const s = await state();
    const text = s.text || '';
    const url = s.url || '';
    if (!/accounts\.google\.com/.test(url)) return true;
    if (/session ended|not signed in|Try signing in again|Try again/i.test(text)) {
      await clickText('Try again').catch(() => {});
      await idle('deliberate');
      continue;
    }

    if (/Email or phone|Sign in|Use your Google Account/i.test(text) && s.inputs.some((input) => /email|identifier/i.test(`${input.type} ${input.name} ${input.aria}`) && input.visible)) {
      await fill('input[type="email"], input[name="identifier"], input#identifierId', creds.email || EMAIL);
      await clickText('Next').catch(async () => press('Enter'));
      continue;
    }

    if (/Enter your password|password/i.test(text) && s.inputs.some((input) => /password|Passwd/i.test(`${input.type} ${input.name}`) && input.visible)) {
      await fill('input[type="password"], input[name="Passwd"]', creds.password);
      await press('Enter');
      continue;
    }

    if (/Tap Yes on your phone|Gmail app|Try another way|More ways to verify|Choose how you want to sign in/i.test(text) && !/Enter code|verification code from the Google Authenticator app/i.test(text)) {
      let after = s;
      if (/Try another way|More ways to verify/i.test(text)) {
        await clickText(['Try another way', 'More ways to verify']).catch(() => {});
        await idle('deliberate');
        after = await state();
      }
      if (/Tap Yes on your phone|Gmail app|phone or tablet/i.test(after.text || '') && !/Try another way|More ways to verify/i.test(after.text || '')) {
        await clickText(['Tap Yes on your phone or tablet', 'Gmail app', 'phone or tablet']).catch(() => {});
        await idle('deliberate');
        continue;
      }
      if (/Get a verification code from the Google Authenticator app|Google Authenticator app|Authenticator/i.test(after.text || '')) {
        await clickText(['Get a verification code from the Google Authenticator app', 'Google Authenticator app', 'Authenticator']).catch(() => {});
        await idle('deliberate');
        if (await submitStoredGoogleCode(creds)) continue;
      }
      if (creds?.totpSecret && await navigateStoredTotpChallenge(after.url || url)) {
        if (await submitStoredGoogleCode(creds)) continue;
      }
      continue;
    }

    if (/Get a verification code from the Google Authenticator app|Enter code|verification code/i.test(text)) {
      if (!await submitStoredGoogleCode(creds)) return false;
      continue;
    }

    if (/Wrong code|Try again/i.test(text)) {
      if (!await submitStoredGoogleCode(creds, Number('31000'))) return false;
      continue;
    }

    await idle('short');
  }
  return false;
}
