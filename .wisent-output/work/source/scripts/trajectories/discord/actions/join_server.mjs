import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectDiscordBanSignals } from '../../../../dist/platforms/discord/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

const INVITE_URL = process.env.INVITE_URL;
if (!INVITE_URL) { console.log('FAIL: INVITE_URL env required (e.g. https://discord.gg/abc123)'); process.exit(1); }

const acct = await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no active discord account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_join_server', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /discord\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
if (acct.metadata?.discord_token) await s.ctx.addInitScript(`localStorage.setItem("token",${JSON.stringify(JSON.stringify(acct.metadata.discord_token))})`).catch(() => {});
let ban = null;
try {
  await s.goto(INVITE_URL);
  checkReachable(s, 'discord');
  await humanIdlePause('deliberate');
  // Accept Invite — Discord uses <button> with text "Accept Invite" /
  // "Join {Server}". Modal-scoped to avoid hitting random sidebar buttons
  // when an existing /channels session loads.
  const acceptBtn = s.page.locator('button:has-text("Accept Invite"), button:has-text("Join Server"), button:has(div:has-text("Accept Invite")), button:has(div:has-text("Join "))').filter({ visible: true }).first();
  await acceptBtn.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, acceptBtn);
  // Wait for navigation into the joined channel — URL flips to /channels/{guildId}/{channelId}.
  await s.page.waitForFunction(() => /\/channels\/\d+\/\d+/.test(location.pathname), { timeout: 25000 }).catch(() => {});
  // If a rules/gate screen popped up, click "Submit"/"Continue".
  const ruleSubmit = s.page.locator('button:has-text("Submit"), button:has-text("Continue"), button:has-text("Complete")').filter({ visible: true }).first();
  if (await ruleSubmit.isVisible({ timeout: 2500 }).catch(() => false)) {
    await humanClickLocator(s.page, ruleSubmit);
    await humanIdlePause('deliberate');
  }
  if (!/\/channels\/\d+/.test(s.page.url())) throw new Error(`did not land in joined channel — final url=${s.page.url()}`);
  ban = await detectDiscordBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: joined`);
} catch (e) {
  ban = e.banSignal ?? await detectDiscordBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = runRecordingsDir('discord_join_server'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'discord_join_server', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
