// The authenticator setup on the Google security page, and the secret it stores.
import { generateTotp } from '../../../../_shared/services/google_sso.mjs';
import { writeScopedLogin } from '../../../../../_shared/scoped-secrets.mjs';
import { AUTHENTICATOR_URL, SECURITY_URL, redact } from './settings.mjs';
import { clickText, fill, idle, nav, press, state } from './page.mjs';
import { handleGoogleLogin } from './login.mjs';

export function extractSetupSecret(text) {
  const compact = String(text || '').replace(/\s+/g, ' ');
  const labeled = compact.match(/(?:setup key|secret key|key)\D{0,80}([A-Z2-7](?:\s?[A-Z2-7]){15,})/i);
  if (labeled) return labeled[1].toUpperCase().replace(/[^A-Z2-7]/g, '');
  const candidate = compact.match(/\b[A-Z2-7](?:\s?[A-Z2-7]){23,}\b/i);
  return candidate ? candidate[0].toUpperCase().replace(/[^A-Z2-7]/g, '') : '';
}


export async function openAuthenticatorSettings(creds) {
  await nav(AUTHENTICATOR_URL);
  if (/accounts\.google\.com/.test((await state()).url || '')) {
    if (!await handleGoogleLogin(creds)) return false;
    await nav(AUTHENTICATOR_URL);
  }
  const s = await state();
  if (/security/i.test(s.url || '') && !/Authenticator app|2-Step Verification|Change authenticator/i.test(s.text || '')) {
    await nav(SECURITY_URL);
    await clickText(['2-Step Verification', '2-step verification']).catch(() => {});
  }
  return true;
}

export async function activateSetup(creds) {
  const steps = [];
  if (!await openAuthenticatorSettings(creds)) return { ok: false, blocked: 'google_login_failed_or_manual_code_timeout', steps };

  for (let i = 0; i < 30; i += 1) {
    const s = await state();
    const text = s.text || '';
    steps.push({ i, url: s.url, textPreview: redact(text).slice(0, 500) });

    if (/accounts\.google\.com/.test(s.url || '')) {
      if (!await handleGoogleLogin(creds)) return { ok: false, blocked: 'google_reauth_failed_or_manual_code_timeout', steps };
      continue;
    }

    if (/Remove anyway/i.test(text)) {
      await clickText('Cancel').catch(() => {});
      continue;
    }

    if (/Change authenticator app/i.test(text)) {
      await clickText('Change authenticator app');
      continue;
    }

    if (/Set up authenticator|Add authenticator|Authenticator app/i.test(text) && !/Enter code|verification code/i.test(text)) {
      await clickText(['Set up authenticator', 'Add authenticator', 'Authenticator app', 'Get started']).catch(() => {});
      continue;
    }

    if (/QR code|scan|setup key|secret key|Can.?t scan/i.test(text) && !/Enter code|verification code/i.test(text)) {
      if (!/setup key|secret key/i.test(text)) await clickText(["Can't scan it", 'setup key', 'Enter a setup key']).catch(() => {});
      await idle('deliberate');
      const withKey = await state();
      const setupSecret = extractSetupSecret(withKey.text || '');
      if (!setupSecret) return { ok: false, blocked: 'google_setup_key_not_found', steps };
      await clickText(['Next', 'Continue']).catch(() => {});
      await idle('deliberate');
      const code = generateTotp(setupSecret);
      await fill('input[name="totpPin"], input[name="Pin"], input[type="tel"], input[type="text"], input[inputmode="numeric"]', code);
      await clickText(['Verify', 'Next', 'Done']).catch(async () => press('Enter'));
      await idle('deliberate');
      const after = await state();
      if (/Wrong code|Try again|Invalid code|Couldn.?t verify/i.test(after.text || '')) {
        const retry = generateTotp(setupSecret, { now: Date.now() + 31_000 });
        await fill('input[name="totpPin"], input[name="Pin"], input[type="tel"], input[type="text"], input[inputmode="numeric"]', retry);
        await clickText(['Verify', 'Next', 'Done']).catch(async () => press('Enter'));
        await idle('deliberate');
      }
      const finalState = await state();
      if (/Wrong code|Try again|Invalid code|Couldn.?t verify/i.test(finalState.text || '')) return { ok: false, blocked: 'new_google_totp_code_rejected', steps };
      writeScopedLogin('googleAds', {
        email: creds.email,
        password: creds.password,
        totpSecret: setupSecret,
      });
      return { ok: true, activated: true, stored: true, url: finalState.url, steps };
    }

    if (/Enter code|verification code/i.test(text)) {
      const setupSecret = extractSetupSecret(text);
      if (setupSecret) {
        const code = generateTotp(setupSecret);
        await fill('input[name="totpPin"], input[name="Pin"], input[type="tel"], input[type="text"], input[inputmode="numeric"]', code);
        await clickText(['Verify', 'Next', 'Done']).catch(async () => press('Enter'));
        continue;
      }
      return { ok: false, blocked: 'code_input_without_setup_key', steps };
    }

    await idle('short');
  }

  return { ok: false, blocked: 'authenticator_activation_state_not_reached', steps };
}
