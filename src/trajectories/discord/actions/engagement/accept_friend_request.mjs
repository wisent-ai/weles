// Discord accept-friend-request trajectory. LIGHT_ENGAGEMENT tier per
// lifecycle.ts. Surfaces inbound friend requests on /channels/@me ->
// Pending tab and clicks the green Accept button per row up to limit.
//
// Env vars:
//   ACCEPT_LIMIT — max requests to accept per run (default 3).
//
// Sequence:
//   1. Source account, start WSession, addInitScript-inject discord_token.
//   2. Navigate /channels/@me.
//   3. Click Pending tab on the Friends panel.
//   4. For each row up to ACCEPT_LIMIT, observe its acceptance response.
//   5. Persist each acknowledged target before observing removal of its control.

import { runOutputPath } from '#run-output';
import { WSession } from '../../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../../dist/human/mouse.js';
import {
  getSocialAccount,
  resolveAccountSession,
} from '../../../../../dist/utils/credentials.js';
import { updateAccountMetadata } from '../../../_shared/skarbiec/accounts.mjs';
import {
  pageSettled,
  responseAfterAction,
} from '../../../_shared/page/settled.mjs';
import { checkReachable } from '../../../_shared/action-runner.mjs';
import { readDiscordNoContent } from '../../../_shared/discord/response.mjs';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const rawLimit = process.env.ACCEPT_LIMIT ?? '3';
const ACCEPT_LIMIT = Number(rawLimit);
if (
  !/^\d+$/.test(rawLimit) ||
  !Number.isSafeInteger(ACCEPT_LIMIT) ||
  ACCEPT_LIMIT < 1
) {
  console.error(
    'DISCORD_ACCEPT_LIMIT_INVALID: ACCEPT_LIMIT must be a positive integer; observed',
    JSON.stringify(rawLimit),
  );
  process.exit(1);
}

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) {
  console.log('FAIL: no discord account');
  process.exit(1);
}
const token = acct.metadata?.discord_token;
if (!token) {
  console.log(`FAIL: ${acct.username} metadata.discord_token missing`);
  process.exit(1);
}
if (!acct.id) {
  console.error('DISCORD_ACCEPT_ACCOUNT_ID_UNAVAILABLE');
  process.exit(1);
}

const opts = await resolveAccountSession(acct);
const s = await WSession.start({
  label: 'discord_accept_friend_request',
  proxy: opts.proxyUrl,
  persona: opts.persona,
  targetHost: 'discord.com',
});
console.log(`[accept_friend] account=${acct.username} limit=${ACCEPT_LIMIT}`);

const accepted = [];
let emptyStateObserved = false;
const relationshipPath = /^\/api\/v\d+\/users\/@me\/relationships\/(\d+)$/;

try {
  await s.ctx.addInitScript((value) => {
    if (location.hostname === 'discord.com')
      localStorage.setItem('token', JSON.stringify(value));
  }, token);
  await s.goto('https://discord.com/channels/@me');
  checkReachable(s, 'discord');
  // Wait for the SPA gateway-hydration splash ("DID YOU KNOW: ...") to
  // clear by waiting for the bottom-left User Settings gear button —
  // it only appears once the user-popout has rendered.
  await s.page
    .locator('button[aria-label="User Settings"]')
    .first()
    .waitFor({ state: 'visible' });

  // Tab text may include a count badge like "Pending (2)" — match prefix.
  const pendingTab = s.page.getByRole('tab', { name: /^Pending/ }).first();
  await pendingTab.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, pendingTab);
  await s.page
    .getByRole('tab', { name: /^Pending/, selected: true })
    .first()
    .waitFor({ state: 'visible' });
  await pageSettled(s.page);

  for (let i = 0; i < ACCEPT_LIMIT; i++) {
    const candidate = s.page
      .locator('button[aria-label*="Accept"]')
      .filter({ visible: true })
      .first();
    const emptyState = s.page
      .getByText(/no pending friend requests/i)
      .filter({ visible: true })
      .first();
    const outgoing = s.page
      .locator('button[aria-label*="Cancel"]')
      .filter({ visible: true })
      .first();
    await candidate
      .or(emptyState)
      .or(outgoing)
      .first()
      .waitFor({ state: 'visible' });
    if ((await candidate.count()) === 0) {
      emptyStateObserved = (await emptyState.count()) > 0;
      if (emptyStateObserved) break;
      throw Object.assign(
        new Error(
          'DISCORD_ACCEPT_PENDING_UNCONFIRMED: no acceptance control or explicit empty state was observed',
        ),
        {
          pageUrl: s.page.url(),
          observedText: await s.page.locator('body').innerText(),
        },
      );
    }
    const target = await candidate.evaluate((button) => {
      // allow-raw-playwright: read-only row identity
      const row = button.closest(
        '[data-list-item-id], li, [class*="peopleListItem"], [class*="friend"]',
      );
      if (!row) return { selector: null, label: null };
      const listId = row.getAttribute('data-list-item-id');
      const selector = row.id
        ? `#${CSS.escape(row.id)}`
        : listId
          ? `[data-list-item-id="${CSS.escape(listId)}"]`
          : null;
      const label =
        row
          .querySelector('[class*="username"], [class*="displayName"]')
          ?.textContent?.trim() || null;
      return { selector, label, observedText: row.textContent };
    });
    if (!target.selector) {
      throw Object.assign(
        new Error(
          'DISCORD_ACCEPT_TARGET_UNCONFIRMED: the observed row has no stable selector',
        ),
        { observed: target, pageUrl: s.page.url() },
      );
    }
    const acceptBtn = s.page
      .locator(target.selector)
      .locator('button[aria-label*="Accept"]')
      .filter({ visible: true })
      .first();
    const response = await responseAfterAction(
      s.page,
      (request) => {
        const url = new URL(request.url());
        return (
          request.method() === 'PUT' &&
          url.origin === 'https://discord.com' &&
          relationshipPath.test(url.pathname)
        );
      },
      () => humanClickLocator(s.page, acceptBtn),
    );
    await readDiscordNoContent(
      response,
      'accept_friend_request',
      'DISCORD_ACCEPT',
    );
    const targetId = relationshipPath.exec(
      new URL(response.url()).pathname,
    )?.[1];
    if (!targetId) {
      throw Object.assign(
        new Error(
          'DISCORD_ACCEPT_TARGET_UNCONFIRMED: reconcile the acknowledged response before another attempt',
        ),
        {
          requestUrl: response.url(),
          httpStatus: response.status(),
          observed: target,
        },
      );
    }
    const entry = {
      target: target.label || targetId,
      target_id: targetId,
      at: new Date().toISOString(),
      acknowledgement: 'provider_response',
    };
    accepted.push(entry);
    updateAccountMetadata(acct.id, (current) => ({
      ...current,
      friend_requests_accepted: [
        ...(Array.isArray(current?.friend_requests_accepted)
          ? current.friend_requests_accepted
          : []),
        entry,
      ],
    }));
    console.log(
      `[accept_friend] acknowledged and persisted ${i + 1}: ${targetId}`,
    );
    await acceptBtn.waitFor({ state: 'hidden' });
    await pageSettled(s.page);
  }
  console.log(
    JSON.stringify({
      ok: true,
      operation: 'accept_friend_requests',
      account_id: acct.id,
      accepted,
      limit: ACCEPT_LIMIT,
      empty_state_observed: emptyStateObserved,
    }),
  );
} catch (e) {
  console.error('DISCORD_ACCEPT_FAILED:', e, { acknowledged: accepted });
  try {
    await s.page.screenshot({
      path: runOutputPath('accept_friend_request', `fail_${Date.now()}.png`),
    });
  } catch (cause) {
    console.error('DISCORD_ACCEPT_SCREENSHOT_FAILED:', cause);
  }
  process.exitCode = 1;
} finally {
  await s.close();
}
