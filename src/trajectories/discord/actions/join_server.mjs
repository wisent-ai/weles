import {
  getSocialAccount,
  resolveAccountSession,
} from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectDiscordBanSignals } from '../../../../dist/platforms/discord/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { pageSettled } from '../../_shared/page/settled.mjs';

const INVITE_URL = process.env.INVITE_URL;
if (!INVITE_URL) {
  console.log('FAIL: INVITE_URL env required (e.g. https://discord.gg/abc123)');
  process.exit(1);
}
try {
  const invite = new URL(INVITE_URL);
  const pathAllowed =
    invite.hostname === 'discord.gg'
      ? /^\/[A-Za-z0-9_-]+\/?$/.test(invite.pathname)
      : invite.hostname === 'discord.com' &&
        /^\/invite\/[A-Za-z0-9_-]+\/?$/.test(invite.pathname);
  if (
    invite.protocol !== 'https:' ||
    invite.port ||
    invite.username ||
    invite.password ||
    !pathAllowed
  ) {
    throw new Error(
      'Expected an HTTPS discord.gg/code or discord.com/invite/code URL without embedded credentials or a non-default port.',
    );
  }
} catch (cause) {
  console.error('DISCORD_INVITE_URL_INVALID:', cause, {
    observedUrl: INVITE_URL,
  });
  process.exit(1);
}

const acct = await getSocialAccount('discord');
if (!acct) {
  console.log('FAIL: no active discord account');
  process.exit(1);
}
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({
  label: 'discord_join_server',
  proxy: proxyUrl,
  persona,
});
let ban = null;
let banReadAttempted = false;
let observedPage = false;
try {
  const stored = (acct.metadata?.cookies ?? []).filter((c) =>
    /(^|\.)discord\.com$/.test(c.domain ?? ''),
  );
  if (stored.length)
    await s.ctx.addCookies(stored.map((c) => ({ ...c, path: c.path || '/' })));
  if (acct.metadata?.discord_token)
    await s.ctx.addInitScript((token) => {
      if (location.hostname === 'discord.com')
        localStorage.setItem('token', JSON.stringify(token));
    }, acct.metadata.discord_token);
  await s.goto(INVITE_URL);
  observedPage = true;
  checkReachable(s, 'discord');
  // Accept Invite — Discord uses <button> with text "Accept Invite" /
  // "Join {Server}". Its visible control, not an idle gap, gates the click.
  const acceptBtn = s.page
    .locator(
      'button:has-text("Accept Invite"), button:has-text("Join Server"), button:has(div:has-text("Accept Invite")), button:has(div:has-text("Join "))',
    )
    .filter({ visible: true })
    .first();
  await acceptBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, acceptBtn);
  // The click either lands in the joined channel (/channels/{guildId}/{channelId})
  // or shows a rules/gate screen first; read the settled page to see which.
  await pageSettled(s.page);
  const ruleSubmit = s.page
    .locator(
      'button:has-text("Submit"), button:has-text("Continue"), button:has-text("Complete")',
    )
    .filter({ visible: true })
    .first();
  if (await ruleSubmit.isVisible()) {
    await humanClickLocator(s.page, ruleSubmit);
    await pageSettled(s.page);
  }
  if (!/\/channels\/\d+/.test(s.page.url()))
    throw new Error(
      `did not land in joined channel — final url=${s.page.url()}`,
    );
  banReadAttempted = true;
  ban = await detectDiscordBanSignals(s.page, s.capturedResponses);
  console.log(`[ban-signal] ${ban?.signal}  PASS: joined`);
} catch (e) {
  console.error('DISCORD_JOIN_FAILED:', e);
  if (e.banSignal) ban = e.banSignal;
  else if (observedPage && !banReadAttempted) {
    banReadAttempted = true;
    try {
      ban = await detectDiscordBanSignals(s.page, s.capturedResponses);
    } catch (cause) {
      console.error('DISCORD_JOIN_BAN_READ_FAILED:', cause);
    }
  }
  process.exitCode = 1;
} finally {
  if (ban) {
    try {
      const dir = runRecordingsDir('discord_join_server');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'ban_signal.json'),
        JSON.stringify(
          {
            account_id: acct.id,
            username: acct.username,
            action: 'discord_join_server',
            ...ban,
            ts: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch (cause) {
      console.error('DISCORD_JOIN_DIAGNOSTIC_WRITE_FAILED:', cause);
      process.exitCode = 1;
    }
  }
  await s.close();
}
