// Whose session this is and which ad account it is pointed at.
//
// Three questions live here: is the browser showing a login or checkpoint
// address instead of Ads Manager, did a human finish logging in while we
// waited, and is the account on screen the one the run named. The last one is
// a refusal, not a warning: a draft built in the wrong ad account spends
// somebody else's money.

import { spawnSync } from 'node:child_process';
import { AD_ACCOUNT_ID, AD_ACCOUNT_NAME, BUSINESS_ID, LOGIN_WAIT_MS, WAIT_FOR_LOGIN, targetUrl } from './campaign_request.mjs';
import { pageText } from './panel_controls.mjs';

async function bringBrowserToFront(s) {
  await s.page.bringToFront();
  if (process.platform !== 'darwin') return;
  spawnSync('osascript', ['-e', 'tell application "Chromium" to activate'], { stdio: 'ignore' });
  spawnSync('osascript', ['-e', 'tell application "System Events" to set frontmost of every process whose name is "Chromium" to true'], { stdio: 'ignore' });
}

function isLoginUrl(url) {
  return /facebook\.com\/login|business\.facebook\.com\/business\/loginpage|checkpoint|recover/i.test(url);
}

// Returns only when Ads Manager is on screen; every other outcome is a
// refusal with exit code 2, the code that means "this session is unusable".
async function passLoginGate(s) {
  let url = s.page.url?.() ?? '';
  if (isLoginUrl(url)) {
    if (!WAIT_FOR_LOGIN) {
      console.log(`FAIL: facebook session expired or checkpointed (${url})`);
      process.exit(2);
    }
    console.log(`[meta-ads] waiting for manual login, deadline=${LOGIN_WAIT_MS}ms`);
    await bringBrowserToFront(s);
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      await s.wait(3);
      url = s.page.url?.() ?? '';
      if (!isLoginUrl(url)) break;
    }
    if (isLoginUrl(url)) {
      console.log(`FAIL: manual login did not complete (${url})`);
      process.exit(2);
    }
    await s.goto(targetUrl);
    await s.wait(8);
  }
  if (/business\.facebook\.com\/security|two_factor|checkpoint/i.test(await pageText(s))) {
    console.log('FAIL: Meta account requires security verification');
    process.exit(2);
  }
}

// URLSearchParams answers null for an address without `act`, and that is the
// answer this returns; a present value only loses the `act_` prefix.
function currentAdAccountId(url) {
  if (!URL.canParse(url)) return null;
  const act = new URL(url).searchParams.get('act');
  return act === null ? null : act.replace(/^act_/, '');
}

// The account Ads Manager is showing, read off the header line that carries
// its numeric id in brackets. No such line on the page is its own answer.
async function visibleSelectedAdAccount(s) {
  const text = await pageText(s);
  const accountLine = text.split('\n').map((line) => line.trim()).find((line) => /\(\d{6,}\)/.test(line));
  if (accountLine === undefined) return { id: null, label: null };
  const [, id] = accountLine.match(/\((\d{6,})\)/);
  return { id, label: accountLine };
}

async function ensureAdAccount(s) {
  const before = currentAdAccountId(s.page.url?.() ?? '');
  console.log(`[meta-ads] current ad account=${before || 'unknown'} target=${AD_ACCOUNT_ID || 'unspecified'}`);
  if (!AD_ACCOUNT_ID) return before;

  if (before !== AD_ACCOUNT_ID) {
    const params = new URLSearchParams({ act: AD_ACCOUNT_ID });
    if (BUSINESS_ID) params.set('business_id', BUSINESS_ID);
    const switchUrl = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?${params}`;
    console.log(`[meta-ads] switching ad account -> ${AD_ACCOUNT_ID}`);
    await s.goto(switchUrl);
    await s.wait(8);
  }
  const after = currentAdAccountId(s.page.url?.() ?? '');
  const visible = await visibleSelectedAdAccount(s);
  console.log(`[meta-ads] ad account after switch=${after || 'unknown'} visible=${visible.label || 'unknown'}`);
  if (after !== AD_ACCOUNT_ID) {
    console.log(`FAIL: wrong Meta ad account selected; expected=${AD_ACCOUNT_ID} actual=${after || 'unknown'} url=${s.page.url?.() ?? ''}`);
    process.exit(1);
  }
  if (visible.id && visible.id !== AD_ACCOUNT_ID) {
    console.log(`FAIL: Meta visible account mismatch; expected=${AD_ACCOUNT_ID} actual=${visible.id} label=${visible.label || ''}`);
    process.exit(1);
  }
  if (AD_ACCOUNT_NAME && visible.label && !visible.label.toLowerCase().includes(AD_ACCOUNT_NAME.toLowerCase())) {
    console.log(`FAIL: Meta visible account name mismatch; expected contains=${AD_ACCOUNT_NAME} label=${visible.label}`);
    process.exit(1);
  }
  return after;
}

export {
  bringBrowserToFront,
  ensureAdAccount,
  passLoginGate,
  visibleSelectedAdAccount,
};
