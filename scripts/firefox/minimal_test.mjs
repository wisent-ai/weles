// Most-minimal: just launch, immediately close. No context, no page.
// Narrows down whether the VMAPPLE runner chokes on launch itself.
import { firefox } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BIN = process.env.WELES_FIREFOX_BIN ||
  join(process.env.HOME, '.local/share/weles-firefox/142.0a1-weles.5/Firefox.app/Contents/MacOS/firefox');
if (!existsSync(BIN)) { console.error(`FAIL: bin missing at ${BIN}`); process.exit(1); }
console.log(`binary: ${BIN}`);

const b = await firefox.launch({ executablePath: BIN, headless: true });
console.log('launch: OK (got browser handle)');
console.log('contexts before newContext:', b.contexts().length);
await b.close();
console.log('close: OK');
