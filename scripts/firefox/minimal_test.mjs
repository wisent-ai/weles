// Minimal: just launch firefox via bare Playwright (no weles init scripts)
// and go to about:blank. Isolates whether the weles 20KB addInitScript is
// the cause of pipe-closed failures on CI.
import { firefox } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BIN = process.env.WELES_FIREFOX_BIN ||
  join(process.env.HOME, '.local/share/weles-firefox/142.0a1-weles.5/Firefox.app/Contents/MacOS/firefox');
if (!existsSync(BIN)) { console.error(`FAIL: bin missing at ${BIN}`); process.exit(1); }
console.log(`binary: ${BIN}`);

const b = await firefox.launch({ executablePath: BIN, headless: true });
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.goto('about:blank');
console.log('minimal launch: OK');
await b.close();
