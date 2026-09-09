// The two things OpenAI asks of a brand-new identity, both answered from this
// account's own Gmail mailbox: accepting the ChatGPT workspace invitation, and
// finishing the e-mail verification.
//
// Neither step reads a second credential and neither involves a phone number:
// the session is already signed in as the very account both messages were sent
// to. Both are bounded and run once per run.
import { humanClick, humanClickLocator, humanIdlePause as pause } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { clickVisibleText, navEval } from './page_controls.mjs';

// Accept the ChatGPT workspace invitation waiting in this account's own mailbox.
//
// A Google identity with no ChatGPT account is pushed into personal signup, and
// personal signup asks for a phone number. An invited seat does not need one:
// its account is created by accepting the invitation, and that invitation is in
// the mailbox of the very account this session is already signed in as, so no
// second credential is read and no phone number is involved.
//
// Bounded, once per run. The link is followed by href rather than by clicking
// through a new tab, because a background tab is a second page to track for no
// gain. Returns the URL the flow ended at, or null when there is no invitation.
export async function acceptPendingWorkspaceInvite(page, login, mark) {
  mark('workspace_invite_lookup');
  const query = encodeURIComponent('from:openai.com (invite OR invitation OR workspace)');
  await page.goto(`https://mail.google.com/mail/u/0/#search/${query}`, { waitUntil: 'commit' });
  let opened = false;
  for (let i = 0; i < 60; i += 1) {
    const row = await navEval(page, () => {
      for (const element of Array.from(document.querySelectorAll('tr.zA, div[role="listitem"]'))) {
        const text = (element.innerText || '').replace(/\s+/g, ' ').trim();
        if (!/invit/i.test(text)) continue;
        const box = element.getBoundingClientRect();
        if (box.width < 20 || box.height < 8) continue;
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      return null;
    }, null);
    if (row) {
      await humanClick(page, Math.round(row.x), Math.round(row.y));
      opened = true;
      break;
    }
    await page.waitForTimeout(500); // allow-raw-playwright: mail list render poll
  }
  if (!opened) {
    console.log(`[google_sso] no ChatGPT invitation in the mailbox of ${login.email}`);
    return null;
  }
  mark('workspace_invite_opened');
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    target = await navEval(page, () => {
      const wanted = /(chatgpt\.com|chat\.openai\.com|auth\.openai\.com)\/[^"']*(invit|join|accept)/i;
      for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
        const href = anchor.getAttribute('href');
        if (wanted.test(href)) return href;
      }
      return null;
    }, null);
    if (target) break;
    await page.waitForTimeout(500); // allow-raw-playwright: message body render poll
  }
  if (!target) {
    console.log('[google_sso] the invitation mail carries no workspace acceptance link');
    return null;
  }
  await page.goto(target, { waitUntil: 'commit' });
  await pause('deliberate');
  try {
    const clicked = await clickVisibleText(
      page,
      /^(accept invite|accept invitation|accept|join workspace|join|continue)$/i,
    );
    mark('workspace_invite_accepted');
    console.log(`[google_sso] clicked the workspace acceptance control "${clicked}"`);
  } catch (e) {
    console.log(`[google_sso] no acceptance control on the invitation page: ${e.message.slice(0, 120)}`);
  }
  await pause('long');
  const landed = await navEval(page, () => location.href, '?');
  console.log(`[google_sso] the workspace invitation flow ended at ${landed}`);
  return landed;
}

// Finish OpenAI's email verification from the same mailbox.
//
// Accepting a workspace invitation can leave the account one step short: OpenAI
// mails a verification link (or a six-digit code) and parks on
// /email-verification until it is used. The mail arrives in the account this
// session is already signed in as, so the step needs no phone, no second
// credential and no operator. Bounded and once per run.
export async function completeEmailVerification(page, login, mark) {
  mark('email_verification_lookup');
  const query = encodeURIComponent('from:openai.com (verify OR verification OR code)');
  await page.goto(`https://mail.google.com/mail/u/0/#search/${query}`, { waitUntil: 'commit' });
  let opened = false;
  for (let i = 0; i < 90; i += 1) {
    const row = await navEval(page, () => {
      for (const element of Array.from(document.querySelectorAll('tr.zA, div[role="listitem"]'))) {
        const text = (element.innerText || '').replace(/\s+/g, ' ').trim();
        if (!/verif|code/i.test(text)) continue;
        const box = element.getBoundingClientRect();
        if (box.width < 20 || box.height < 8) continue;
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      return null;
    }, null);
    if (row) {
      await humanClick(page, Math.round(row.x), Math.round(row.y));
      opened = true;
      break;
    }
    await page.waitForTimeout(1000); // allow-raw-playwright: verification mail delivery poll
  }
  if (!opened) {
    console.log(`[google_sso] no OpenAI verification mail in the mailbox of ${login.email}`);
    return null;
  }
  mark('email_verification_opened');
  const found = await navEval(page, () => {
    const wanted = /(auth\.openai\.com|chatgpt\.com)\/[^"']*(verify|verification|confirm)/i;
    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      const href = anchor.getAttribute('href');
      if (wanted.test(href)) return { link: href };
    }
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const code = body.match(/\b(\d{6})\b/);
    return code ? { code: code[1] } : null;
  }, null);
  if (!found) {
    console.log('[google_sso] verification mail carries neither a link nor a code');
    return null;
  }
  if (found.link) {
    await page.goto(found.link, { waitUntil: 'commit' });
    await pause('deliberate');
    mark('email_verification_link_used');
  } else {
    await page.goBack({ waitUntil: 'commit' });
    const field = page
      .locator('input[autocomplete="one-time-code"], input[name="code"], input[type="tel"], input[type="text"]')
      .filter({ visible: true })
      .first();
    await field.waitFor({ state: 'visible' });
    await humanClickLocator(page, field);
    await humanFill(page, field, found.code);
    mark('email_verification_code_entered');
    try { await clickVisibleText(page, /^(continue|verify|submit|next)$/i); } catch { /* some forms submit on entry */ }
    await pause('long');
  }
  const landed = await navEval(page, () => location.href, '?');
  console.log(`[google_sso] email verification ended at ${landed}`);
  return landed;
}
