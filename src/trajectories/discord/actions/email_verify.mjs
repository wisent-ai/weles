// Discord email-verify trajectory. Drives the SPA verify flow for a freshly
// registered Discord account whose email is sitting on the Unverified state
// in User Settings. Sequence captured 1:1 from a keeper-driven demo.
//
// The inbox has no push or blocking read, so the flow never waits for mail:
//   1. Source account via getSocialAccount('discord') + persona/proxy from
//      resolveAccountSession. Start WSession.
//   2. Restore login state from metadata.discord_token via addInitScript
//      seeding localStorage.token on every discord.com document load.
//   3. Read the inbox once. When a "Verify Email Address for Discord" mail
//      sent after the last resend this account recorded is there, follow its
//      click.discord.com redirect to discord.com/verify#token=..., open it,
//      read "Email Verified" and persist metadata.email_verified_at.
//   4. Otherwise open User Settings, click Resend Verification Email, record
//      metadata.email_verify_requested_at and stop with a named error; the
//      next run finds the mail.
import { updateAccountMetadata } from '../../_shared/skarbiec/accounts.mjs';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import {
  getSocialAccount,
  resolveAccountSession,
} from '../../../../dist/utils/credentials.js';
import {
  getReceived,
  listReceivedFrom,
  receivingConfigured,
} from '../../../_shared/resend-receiving.mjs';
import {
  pageSettled,
  responseAfterAction,
} from '../../_shared/page/settled.mjs';
import { checkReachable } from '../../_shared/action-runner.mjs';
import {
  readDiscordNoContent,
  readDiscordText,
} from '../../_shared/discord/response.mjs';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
if (!receivingConfigured()) {
  console.error('DISCORD_EMAIL_INBOX_UNCONFIGURED:', {
    STADO_INTEGRATION_API_URL: Boolean(
      process.env.STADO_INTEGRATION_API_URL?.trim(),
    ),
    WELES_STADO_INTEGRATION_TOKEN: Boolean(
      process.env.WELES_STADO_INTEGRATION_TOKEN?.trim(),
    ),
  });
  process.exit(1);
}

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) {
  console.log('FAIL: no discord account');
  process.exit(1);
}
const email = acct.metadata?.email;
const token = acct.metadata?.discord_token;
if (!email) {
  console.log(`FAIL: ${acct.username} metadata.email missing`);
  process.exit(1);
}
if (!token) {
  console.log(`FAIL: ${acct.username} metadata.discord_token missing`);
  process.exit(1);
}
if (!acct.id) {
  console.error('DISCORD_EMAIL_ACCOUNT_ID_UNAVAILABLE');
  process.exit(1);
}

async function getVerifiedText(s) {
  const verified = s.page
    .locator('text=Email Verified')
    .filter({ visible: true })
    .first();
  await verified.waitFor({ state: 'visible' });
  return verified.evaluate((element) => ({
    text: element.textContent,
    pageUrl: location.href,
  }));
}

async function fetchInboxRecent() {
  return listReceivedFrom(10, email, 'discord.com');
}

async function fetchEmailBody(id) {
  const j = await getReceived(id);
  const body = j?.html ?? j?.text;
  if (!body) throw new Error(`resend email ${id} has no html/text`);
  return body;
}

async function resolveClickToVerify(link) {
  const source = new URL(link);
  if (
    source.origin !== 'https://click.discord.com' ||
    source.username ||
    source.password
  ) {
    throw Object.assign(new Error('DISCORD_EMAIL_LINK_INVALID'), {
      requestUrl: link,
    });
  }
  let response;
  try {
    response = await fetch(source, { redirect: 'manual' });
  } catch (cause) {
    throw Object.assign(
      new Error('DISCORD_EMAIL_REDIRECT_REQUEST_FAILED', { cause }),
      { requestUrl: source.href },
    );
  }
  const location = response.headers.get('location');
  const details = {
    requestUrl: source.href,
    httpStatus: response.status,
    location,
  };
  let responseBody;
  try {
    responseBody = await response.text();
  } catch (cause) {
    throw Object.assign(
      new Error('DISCORD_EMAIL_REDIRECT_READ_FAILED', { cause }),
      details,
    );
  }
  const isRedirect = response.status >= 300 && response.status < 400;
  if (!response.ok && !isRedirect) {
    throw Object.assign(new Error('DISCORD_EMAIL_REDIRECT_REFUSED'), details, {
      responseBody,
    });
  }
  if (!isRedirect || !location)
    return { ...details, responseBody, verifyUrl: null };
  let destination;
  try {
    destination = new URL(location, source);
  } catch (cause) {
    throw Object.assign(
      new Error('DISCORD_EMAIL_REDIRECT_INVALID', { cause }),
      details,
    );
  }
  const trusted =
    destination.origin === 'https://discord.com' &&
    destination.pathname === '/verify' &&
    !destination.username &&
    !destination.password &&
    new URLSearchParams(destination.hash.slice(1)).get('token');
  return { ...details, verifyUrl: trusted ? destination.href : null };
}

const opts = await resolveAccountSession(acct);
const s = await WSession.start({
  label: 'discord_email_verify',
  proxy: opts.proxyUrl,
  persona: opts.persona,
  targetHost: 'discord.com',
});
console.log(`[email_verify] account=${acct.username} email=${email}`);

// The verify URL from a mail already in the inbox that was sent after this
// account's last recorded resend, or null when there is none.
async function verifyUrlFromInbox() {
  const requestedAt = Date.parse(
    acct.metadata?.email_verify_requested_at ?? '',
  );
  if (!requestedAt) return null;
  const candidate = (await fetchInboxRecent()).find((m) => {
    const subj = typeof m.subject === 'string' ? m.subject : '';
    const created = m.created_at ? Date.parse(m.created_at) : 0;
    return subj.includes('Verify') && created >= requestedAt;
  });
  if (!candidate) return null;
  const body = await fetchEmailBody(candidate.id);
  const links = body.match(/https:\/\/click\.discord\.com[^\s"<>]+/g);
  if (!links)
    throw new Error(
      `discord_email_verify: mail ${candidate.id} has no click.discord.com links`,
    );
  const redirects = [];
  for (const link of links) {
    const resolved = await resolveClickToVerify(link);
    redirects.push(resolved);
    if (resolved.verifyUrl) return resolved.verifyUrl;
  }
  throw Object.assign(new Error('DISCORD_EMAIL_VERIFY_LINK_UNCONFIRMED'), {
    emailId: candidate.id,
    redirects,
  });
}

try {
  await s.ctx.addInitScript((value) => {
    if (location.hostname === 'discord.com')
      localStorage.setItem('token', JSON.stringify(value));
  }, token);
  const verifyUrl = await verifyUrlFromInbox();
  if (!verifyUrl) {
    await s.goto('https://discord.com/channels/@me');
    checkReachable(s, 'discord');
    const gear = s.page.locator('button[aria-label="User Settings"]').first();
    await gear.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, gear);
    await pageSettled(s.page);
    const resend = s.page
      .locator('button')
      .filter({ hasText: 'Resend Verification Email', visible: true })
      .first();
    if ((await resend.count()) === 0) {
      throw Object.assign(
        new Error(
          'DISCORD_EMAIL_STATUS_UNCONFIRMED: the resend control is absent; this is not proof of verification',
        ),
        {
          pageUrl: s.page.url(),
          observedSettingsText: await s.page.locator('body').innerText(),
        },
      );
    }
    const requestedAt = new Date().toISOString();
    const response = await responseAfterAction(
      s.page,
      (request) => {
        const url = new URL(request.url());
        return (
          request.method() === 'POST' &&
          url.origin === 'https://discord.com' &&
          /^\/api\/v\d+\/auth\/verify\/resend$/.test(url.pathname)
        );
      },
      () => humanClickLocator(s.page, resend),
    );
    await readDiscordNoContent(
      response,
      'resend_verification_email',
      'DISCORD_EMAIL_RESEND',
    );
    updateAccountMetadata(acct.id, { email_verify_requested_at: requestedAt });
    throw Object.assign(
      new Error(
        'DISCORD_EMAIL_VERIFICATION_PENDING: the resend was acknowledged; run again to read the inbox and observe verification',
      ),
      {
        email,
        requestedAt,
        requestUrl: response.url(),
        httpStatus: response.status(),
      },
    );
  }
  console.log(`[email_verify] verify_url=${verifyUrl}...`);

  const response = await responseAfterAction(
    s.page,
    (request) => {
      const url = new URL(request.url());
      return (
        request.method() === 'POST' &&
        url.origin === 'https://discord.com' &&
        /^\/api\/v\d+\/auth\/verify$/.test(url.pathname)
      );
    },
    async () => {
      await s.goto(verifyUrl);
      checkReachable(s, 'discord');
    },
  );
  await readDiscordText(response, 'verify_email', 'DISCORD_EMAIL_VERIFY');
  const verified = await getVerifiedText(s);
  const verifiedPage = new URL(verified.pageUrl);
  if (
    verifiedPage.origin !== 'https://discord.com' ||
    verifiedPage.pathname !== '/verify' ||
    !verified.text?.includes('Email Verified')
  ) {
    throw Object.assign(new Error('DISCORD_EMAIL_VERIFICATION_UNCONFIRMED'), {
      observed: verified,
    });
  }
  console.log(`[email_verify] page shows: ${verified.text}`);

  const verifiedAt = new Date().toISOString();
  updateAccountMetadata(acct.id, { email_verified_at: verifiedAt });
  console.log(
    JSON.stringify({
      ok: true,
      operation: 'verify_email',
      acknowledgement: 'provider_response_and_visible_confirmation',
      account_id: acct.id,
      email,
      email_verified_at: verifiedAt,
      request_url: response.url(),
      http_status: response.status(),
    }),
  );
} catch (e) {
  console.error('DISCORD_EMAIL_VERIFY_FAILED:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
