import { captureAppleNativeTwoFactor, waitForAppleNativeTwoFactorCode } from './native_2fa.mjs';

const pidArgIndex = process.argv.indexOf('--pid');
const pid = pidArgIndex >= 0 ? Number(process.argv[pidArgIndex + 1]) : null;
const once = process.argv.includes('--once')
  || process.argv.includes('--no-click-allow')
  || process.argv.includes('--no-click-done')
  || Number.isFinite(pid);

const result = once
  ? captureAppleNativeTwoFactor({
      clickAllow: !process.argv.includes('--no-click-allow'),
      clickDone: !process.argv.includes('--no-click-done'),
      pid: Number.isFinite(pid) ? pid : undefined,
    })
  : await waitForAppleNativeTwoFactorCode(null, {
      logPrefix: '[apple-native-2fa]',
      clickAllow: true,
      clickDone: true,
    });

console.log(JSON.stringify({
  ...result,
  code: undefined,
}, null, 2));

if (result.ok === false || result.accessibilityTrusted === false) {
  process.exit(1);
}
process.exit(result.code || result.codeCaptured || result.clicked?.length ? 0 : 2);
