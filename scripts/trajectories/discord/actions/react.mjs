import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectDiscordBanSignals } from '../../../../dist/platforms/discord/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const channelPath = process.env.SERVER_CHANNEL_PATH || '@me';
const acct = await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no active discord account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_react', proxy: proxyUrl, persona });
let ban = null;
try {
  await s.goto(`https://discord.com/channels/${channelPath}`);
  checkReachable(s, 'discord');
  await s.page.waitForTimeout(3000);
  const result = await execute(s, `You are in a Discord channel. Hover over the most recent visible message in the channel, then click the "Add Reaction" smiley icon that appears in the message toolbar. In the emoji picker, click any thumbs-up or similar positive emoji. done(value="reacted"). Do NOT navigate(). Do NOT give_up.`, { flowName: 'discord_react' });
  ban = await detectDiscordBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectDiscordBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'discord_react'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'discord_react', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
