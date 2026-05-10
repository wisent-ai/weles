import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { detectDiscordBanSignals } from '../../../../dist/platforms/discord/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

const channelPath = process.env.SERVER_CHANNEL_PATH || '@me';
const acct = await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no active discord account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_react', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /discord\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
if (acct.metadata?.discord_token) await s.ctx.addInitScript(`localStorage.setItem("token",${JSON.stringify(JSON.stringify(acct.metadata.discord_token))})`).catch(() => {});
let ban = null;
try {
  await s.goto(`https://discord.com/channels/${channelPath}`);
  checkReachable(s, 'discord');
  await humanIdlePause('deliberate');
  // Wait for chat messages to render — each message <li id="chat-messages-{channelId}-{messageId}">.
  await s.page.locator('li[id^="chat-messages-"]').first().waitFor({ state: 'visible', timeout: 20000 });
  // Pick the most recent message — last in document order with non-empty content.
  const targetId = await s.page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('li[id^="chat-messages-"]')).reverse();
    for (const li of items) {
      const m = li.id.match(/^chat-messages-(\d+)-(\d+)$/);
      if (m) return { channelId: m[1], messageId: m[2] };
    }
    return null;
  });
  if (!targetId) throw new Error('no message id found in rendered chat');
  // PUT reaction via Discord's web API. localStorage.token carries the
  // Authorization header (matches every other web-client request); this is
  // exactly what the picker UI does once you click an emoji.
  const result = await s.page.evaluate(async ({ channelId, messageId }) => {
    const tk = (() => { try { return JSON.parse(localStorage.token); } catch { return null; } })();
    if (!tk) return { error: 'no_token_in_localstorage' };
    const emoji = encodeURIComponent('\u{1F44D}'); // 👍
    const r = await fetch(`/api/v9/channels/${channelId}/messages/${messageId}/reactions/${emoji}/%40me`, {
      method: 'PUT',
      headers: { Authorization: tk },
    });
    return { status: r.status };
  }, targetId);
  if (result?.error) throw new Error(`react failed: ${result.error}`);
  if (result?.status !== 204 && result?.status !== 200) throw new Error(`react PUT returned ${result?.status}`);
  ban = await detectDiscordBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: reacted on message ${targetId.messageId}`);
} catch (e) {
  ban = e.banSignal ?? await detectDiscordBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'discord_react'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'discord_react', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
