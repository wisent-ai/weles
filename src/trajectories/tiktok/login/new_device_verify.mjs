import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { screenshotIfPossible } from '../../_shared/runner/evidence.mjs';

/** Whether the "Verify it's really you" new-device dialog is on the page. */
export function verifyDialogPresent(page) {
  return page.evaluate(() =>
    /Verify it'?s really you|Verify your identity/i.test(document.body.innerText || '')
  ).catch(() => false);
}

/**
 * Walk the DOM to find the Email row inside the verify dialog: the smallest
 * clickable ancestor that contains both "Email" and "@", excluding the outer
 * "Email or username" login form label.
 */
function findEmailRow(page) {
  return page.evaluate(() => {
    const vh = window.innerHeight, vw = window.innerWidth;
    const all = Array.from(document.querySelectorAll('div, button, li, [role="button"]'));
    const cands = all.filter(el => {
      const t = (el.innerText || '').trim();
      if (!(/\bEmail\b/i.test(t) && /@/.test(t) && t.length < 200 && !/Email or username/i.test(t))) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 150 && r.height >= 30 && r.y >= 0 && r.y + r.height <= vh && r.x >= 0 && r.x + r.width <= vw;
    }).map(el => { const r = el.getBoundingClientRect(); return { tag: el.tagName, cls: (el.className?.toString?.() || '').slice(0,80), area: r.width * r.height, x: r.x + r.width/2, y: r.y + r.height/2, w: Math.round(r.width), h: Math.round(r.height) }; });
    cands.sort((a, b) => a.area - b.area);
    return cands[0] || false;
  }).catch(() => false);
}

/** Click the first visible control among the selectors, if any is on the page. */
async function clickFirstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).filter({ visible: true }).first();
    if (await loc.count().catch(() => false)) {
      try { await humanClickLocator(page, loc); return; } catch {}
    }
  }
}

/**
 * Complete TikTok's "Verify it's really you" new-device email-OTP dialog.
 * Triggered when TikTok sees the login coming from a different IP/UA than the
 * account creation session. The dialog shows an "Email" row with the masked
 * account email — clicking it sends a 6-digit code; we poll the inbox, enter
 * the code, and continue.
 */
export async function completeNewDeviceVerification(s, acct) {
  console.log('[tiktok_login] new-device verify dialog detected — running email OTP flow');
  await screenshotIfPossible(s, 'verify_dialog');
  const emailBox = await findEmailRow(s.page);
  if (!emailBox) throw new Error('verify_otp: could not locate Email option in dialog');
  console.log(`[tiktok_login] verify-dialog Email row: ${JSON.stringify(emailBox)}`);
  await s.page.mouse.click(emailBox.x, emailBox.y);
  await humanIdlePause('deliberate');
  await screenshotIfPossible(s, 'verify_after_email_click');
  // Some flows auto-send; others require explicit Send code click.
  await clickFirstVisible(s.page, ['button:has-text("Send code")', '[data-e2e="send-code-button"]']);
  await humanIdlePause('deliberate');
  // Poll the inbox for the 6-digit code (s.checkEmail handles auth + filter).
  const acctEmail = acct.metadata?.email || `${acct.username}@${process.env.AGENT_DOMAIN || 'pilatesguild.com'}`;
  console.log(`[tiktok_login] polling email for verification code: ${acctEmail}`);
  const code = await s.checkEmail(acctEmail, 'tiktok');
  if (!code || !/^\d{4,8}$/.test(code)) throw new Error(`verify_otp: no code received (got ${code})`);
  console.log(`[tiktok_login] got verification code: ${code}`);
  const codeInput = s.page.locator('input[placeholder*="code" i], input[name*="code" i], input[maxlength="6"]').filter({ visible: true }).first();
  await codeInput.focus().catch(() => false);
  await humanType(s.page, code);
  await humanIdlePause('short');
  await clickFirstVisible(s.page, ['button:has-text("Continue")', 'button:has-text("Next")', 'button[type="submit"]']);
  await humanIdlePause('deliberate');
  await screenshotIfPossible(s, 'verify_after_code_submit');
}
