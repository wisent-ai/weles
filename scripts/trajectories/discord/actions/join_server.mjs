import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectDiscordBanSignals } from '../../../../dist/platforms/discord/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

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
  await s.page.waitForTimeout(3000);
  const result = await execute(s, `You are on a Discord invite page. Click the "Accept Invite" or "Join Server" button. If a rules / gate screen appears, accept the rules. done(value="joined"). Do NOT navigate() beyond the join flow. Do NOT give_up.`, { flowName: 'discord_join_server' });
  ban = await detectDiscordBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectDiscordBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'discord_join_server'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'discord_join_server', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
