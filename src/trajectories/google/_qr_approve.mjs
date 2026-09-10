import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const ADB = process.env.ADB_BIN || 'adb';
const PIXEL_SERIAL = process.env.PIXEL_ADB_SERIAL;
const APPROVE_TIMEOUT_MS = Number(process.env.QR_APPROVE_TIMEOUT_MS ?? 120_000);
const VERIFY_BTN_X = Number(process.env.PIXEL_VERIFY_X ?? 898);
const VERIFY_BTN_Y = Number(process.env.PIXEL_VERIFY_Y ?? 1558);
const CONSTELLATION_ACTIVITY = 'com.google.android.gms.constellation.ui.deeplink.web.WebEntryPointActivity';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function approveQr(page) {
  if (!PIXEL_SERIAL) throw new Error('PIXEL_ADB_SERIAL env var not set (e.g. 192.168.1.50:5555)');

  await assertPixelReady();

  const qrUrl = await extractQrTargetUrl(page);
  console.log(`[qr_approve] target url: ${qrUrl.slice(0, 120)}`);

  await adb('shell', 'svc', 'power', 'stayon', 'true').catch(() => {});
  await adb('shell', 'input', 'keyevent', '224');
  await sleep(300);
  await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', qrUrl);
  console.log('[qr_approve] dispatched to Pixel');

  const heartbeat = setInterval(() => {
    adb('shell', 'input', 'keyevent', '224').catch(() => {});
  }, 20_000);
  try {
    await waitForConstellationActivity(15_000);
    await sleep(2_000);
    console.log(`[qr_approve] tapping Verify at (${VERIFY_BTN_X}, ${VERIFY_BTN_Y})`);
    await adb('shell', 'input', 'tap', String(VERIFY_BTN_X), String(VERIFY_BTN_Y));
    await waitForApprovalAdvance(page, APPROVE_TIMEOUT_MS);
    console.log('[qr_approve] Chromium advanced past QR screen');
  } finally {
    clearInterval(heartbeat);
    await adb('shell', 'svc', 'power', 'stayon', 'false').catch(() => {});
  }
}

async function waitForConstellationActivity(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await execFileP(ADB, ['-s', PIXEL_SERIAL, 'shell', 'dumpsys', 'window'])
      .catch(() => ({ stdout: '' }));
    if (stdout.includes(CONSTELLATION_ACTIVITY)) return;
    await sleep(500);
  }
  throw new Error('constellation_activity_did_not_render');
}

async function assertPixelReady() {
  const { stdout } = await execFileP(ADB, ['-s', PIXEL_SERIAL, 'get-state']).catch((e) => {
    throw new Error(`adb unreachable at ${PIXEL_SERIAL}: ${e.message?.slice(0, 200)}`);
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

async function waitForApprovalAdvance(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const initialUrl = page.url?.() ?? '';
  while (Date.now() < deadline) {
    await sleep(1500);
    const u = page.url?.() ?? '';
    if (u !== initialUrl && !/qrcode|qrsignin|qr_code/i.test(u)) return;
    const stillQr = await page.evaluate(`(() => {
      var t = (document.body && document.body.innerText || '').toLowerCase();
      return /qr code|scan/.test(t);
    })()`).catch(() => true);
    if (!stillQr) return;
  }
  throw new Error('qr_approval_timed_out');
}
