// Launch + newContext + newPage, but NO recordVideo option.
// Narrows whether recordVideo is what's closing the context on VMAPPLE.
import { firefox } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BIN = process.env.WELES_FIREFOX_BIN ||
  join(process.env.HOME, '.local/share/weles-firefox/142.0a1-weles.5/Firefox.app/Contents/MacOS/firefox');
if (!existsSync(BIN)) { console.error(`FAIL: bin missing at ${BIN}`); process.exit(1); }
console.log(`binary: ${BIN}`);

const b = await firefox.launch({ executablePath: BIN, headless: true });
console.log('launch: OK');
const ctx = await b.newContext();
console.log('newContext: OK');
const page = await ctx.newPage();
console.log('newPage: OK');
await page.goto('about:blank');
console.log('goto: OK');
await b.close();
console.log('close: OK');
