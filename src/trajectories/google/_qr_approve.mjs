import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pageCondition, urlMatching } from '../_shared/page/settled.mjs';

const execFileP = promisify(execFile);

const ADB = process.env.ADB_BIN || 'adb';
const PIXEL_SERIAL = process.env.PIXEL_ADB_SERIAL;
// Where the Verify button sits is a fact about one phone's screen, declared
// with the phone; no coordinates are assumed.
const VERIFY_BTN_X = Number(process.env.PIXEL_VERIFY_X);
const VERIFY_BTN_Y = Number(process.env.PIXEL_VERIFY_Y);
const CONSTELLATION_ACTIVITY = 'com.google.android.gms.constellation.ui.deeplink.web.WebEntryPointActivity';

export async function approveQr(page) {
  if (!PIXEL_SERIAL) throw new Error('PIXEL_ADB_SERIAL env var not set (e.g. 192.168.1.50:5555)');
  if (!Number.isInteger(VERIFY_BTN_X) || !Number.isInteger(VERIFY_BTN_Y)) {
    throw new Error('PIXEL_VERIFY_X and PIXEL_VERIFY_Y env vars not set: the screen coordinates of the Verify button on this phone');
  }

  await assertPixelReady();

  const qrUrl = await extractQrTargetUrl(page);
  console.log(`[qr_approve] target url: ${qrUrl}`);

  await adb('shell', 'svc', 'power', 'stayon', 'true');
  await adb('shell', 'input', 'keyevent', '224');
  // `am start -W` returns once the launched activity is displayed.
  await adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', qrUrl);
  console.log('[qr_approve] dispatched to Pixel');
  try {
    await assertConstellationActivity();
    console.log(`[qr_approve] tapping Verify at (${VERIFY_BTN_X}, ${VERIFY_BTN_Y})`);
    await adb('shell', 'input', 'tap', String(VERIFY_BTN_X), String(VERIFY_BTN_Y));
    await waitForApprovalAdvance(page);
    console.log('[qr_approve] Chromium advanced past QR screen');
  } finally {
    await adb('shell', 'svc', 'power', 'stayon', 'false');
  }
}

async function assertConstellationActivity() {
  const { stdout } = await execFileP(ADB, ['-s', PIXEL_SERIAL, 'shell', 'dumpsys', 'window']);
  if (!stdout.includes(CONSTELLATION_ACTIVITY)) throw new Error('constellation_activity_did_not_render: the Pixel shows another activity after the QR link opened');
}

async function assertPixelReady() {
  const { stdout } = await execFileP(ADB, ['-s', PIXEL_SERIAL, 'get-state']).catch((e) => {
    throw new Error(`adb unreachable at ${PIXEL_SERIAL}: ${e.message}`);
  });
  if (!/device/.test(stdout)) throw new Error(`pixel not in "device" state: ${stdout.trim()}`);
}

async function adb(...args) {
  const { stdout } = await execFileP(ADB, ['-s', PIXEL_SERIAL, ...args]);
  return stdout;
}

async function extractQrTargetUrl(page) {
  const fromLink = await page.evaluate(`(() => {
    var links = Array.from(document.querySelectorAll('a[href]'));
    var hit = links.find(function (a) {
      return /qrcode|signin\\/qr|v3\\/signin\\/.*approval/.test(a.href);
    });
    return hit ? hit.href : null;
  })()`).catch(() => null);
  if (fromLink) return fromLink;

  const qr = await page.$('img[alt*="QR" i], img[aria-label*="QR" i], canvas[aria-label*="QR" i], img[src^="data:image/png"]');
  if (!qr) {
    const shot = await page.screenshot({ type: 'png', fullPage: false });
    const decoded = await decodeQr(shot);
    if (decoded) return decoded;
    throw new Error('qr_not_found_in_dom');
  }

  const shot = await qr.screenshot({ type: 'png' });
  const decoded = await decodeQr(shot);
  if (!decoded) throw new Error('qr_decode_failed');
  return decoded;
}

async function decodeQr(pngBuf) {
  const { default: jsQR } = await import('jsqr');
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(pngBuf);
  const out = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return out?.data ?? null;
}

// Chromium leaves the QR screen when the phone approves: either it navigates
// off the QR URL, or the page drops its "QR code / scan" prompt in place.
async function waitForApprovalAdvance(page) {
  const initialUrl = page.url?.() ?? '';
  await Promise.any([
    urlMatching(page, (u) => u !== initialUrl && !/qrcode|qrsignin|qr_code/i.test(u)),
    pageCondition(page, () => !/qr code|scan/.test((document.body && document.body.innerText || '').toLowerCase())),
  ]);
}
