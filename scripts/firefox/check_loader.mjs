// Smoke test for buildInitScript browser-awareness. Runs under `node`; exits
// non-zero on assertion failure.
import { buildInitScript } from '../../dist/scripts/loader.js';

const chromium = buildInitScript({ browser: 'chromium', navigator: {} });
const firefox  = buildInitScript({ browser: 'firefox',  navigator: {} });

const cases = [
  ['chromium contains chrome147 stub', chromium.includes('window.Sanitizer'), true],
  ['chromium omits firefox stub',     chromium.includes('installFirefoxStubs'), false],
  ['firefox  contains firefox stub',  firefox.includes('installFirefoxStubs'),  true],
  ['firefox  omits chrome147 stub',   firefox.includes('window.Sanitizer'),     false],
];
let fail = 0;
for (const [name, got, want] of cases) {
  const ok = got === want;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  (got=${got} want=${want})`);
  if (!ok) fail++;
}
process.exit(fail);
