import { chromium } from 'playwright';

const exe = process.env.HOME + '/Documents/CodingProjects/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium';
const mode = process.argv[2] || 'plain';

const launchOpts = { headless: false, executablePath: exe };
if (mode === 'args' || mode === 'fp') {
  launchOpts.args = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-infobars',
    '--window-position=0,0',
  ];
  launchOpts.ignoreDefaultArgs = ['--enable-automation', '--enable-unsafe-swiftshader', '--disable-breakpad'];
}
if (mode === 'fp') {
  const { generate, toConfig, toCppConfig } = await import('../../dist/fingerprint.js');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const fp = generate('macos');
  const fpConfig = toConfig(fp, 'macos', 'chromium');
  const cppConfig = toCppConfig(fpConfig, 'macos');
  const fpDir = mkdtempSync(join(tmpdir(), 'weles-fp-probe-'));
  const fpFile = join(fpDir, 'config.json');
  writeFileSync(fpFile, JSON.stringify(cppConfig));
  launchOpts.args.push(`--weles-fingerprint=${fpFile}`);
  console.log('[probe] fp config written:', fpFile);
}

console.log(`[probe] mode=${mode} launching weles binary`);
const browser = await chromium.launch(launchOpts);
browser.on('disconnected', () => console.log('[probe] BROWSER disconnected'));
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('crash', () => console.log('[probe] PAGE crash'));
page.on('close', () => console.log('[probe] PAGE close'));

console.log('[probe] navigating to captcha page');
await page.goto('https://www.producthunt.com/my/captcha_verification', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[probe] goto err:', e.message?.slice(0, 100)));

for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const url = page.url();
    const isClosed = page.isClosed();
    console.log(`[probe] t=${(i+1)*2}s url=${url.slice(0, 50)} closed=${isClosed}`);
    if (isClosed) break;
  } catch (e) {
    console.log(`[probe] t=${(i+1)*2}s POLL ERR: ${e.message?.slice(0, 100)}`);
    break;
  }
}
console.log('[probe] done');
await browser.close().catch(() => {});
