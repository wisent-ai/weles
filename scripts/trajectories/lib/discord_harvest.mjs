// Same-session avatar-survey harvest for Discord. Called from
// discord_register.mjs immediately after a successful register+verify so
// that the harvest runs while the session is still authed and pre-disable.
// Discord disables every auto-registered account within hours (verified
// 2026-05-19 on jamesreichert326020 + danawalsh296248 + rickpollich84237 —
// token returns 401 / ACCOUNT_PERMANENTLY_DISABLED on re-login), so a
// separate scrape process has no usable window. Inline harvest is the
// only path. Gated by DISCORD_HARVEST_AFTER_REGISTER=1.

import fs from 'node:fs';
import path from 'node:path';
import { humanScroll, humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';

const DEFAULT_INVITES = 'https://discord.gg/python,https://discord.gg/discord-developers';

async function joinAndOpen(s, invite) {
  await s.goto(invite);
  await humanIdlePause('deliberate');
  for (let i = 0; i < 4; i++) {
    const btn = s.page.locator('button:has-text("Accept Invite"), button:has-text("Join"), button:has-text("Continue")').filter({ visible: true }).first();
    if ((await btn.count()) > 0) {
      try { await humanClickLocator(s.page, btn); await humanIdlePause('deliberate'); }
      catch (e) { console.log(`[harvest] invite btn click err: ${e.message?.slice(0, 80)}`); }
    }
    if (/\/channels\/\d+/.test(s.page.url())) break;
    await humanIdlePause('short');
  }
  for (let i = 0; i < 12; i++) {
    if (/\/channels\/\d+\/\d+/.test(s.page.url())) break;
    const ch = s.page.locator('a[href*="/channels/"][data-list-item-id*="channels"]').filter({ visible: true }).first();
    if ((await ch.count()) > 0) {
      try { await humanClickLocator(s.page, ch); }
      catch (e) { console.log(`[harvest] channel click err: ${e.message?.slice(0, 80)}`); }
    }
    await humanIdlePause('short');
  }
  return /\/channels\/\d+\/\d+/.test(s.page.url());
}

async function scrollAndHarvest(s, targetCount) {
  const found = new Map();
  for (let i = 0; i < 60 && found.size < targetCount; i++) {
    let batch = [];
    try {
      batch = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM scrape of avatar img srcs, no interaction
        const out = [];
        for (const img of document.querySelectorAll('img[src*="cdn.discordapp.com/avatars/"]')) {
          const src = img.getAttribute('src'); if (!src) continue;
          const m = src.match(/avatars\/(\d+)\/([A-Za-z0-9_]+)/); if (!m) continue;
          const li = img.closest('li[id^="chat-messages-"]') || img.closest('li');
          let name = '';
          if (li) { const u = li.querySelector('[id^="message-username-"], [class*="username"]'); if (u && u.textContent) name = u.textContent.trim().slice(0, 80); }
          out.push({ id: m[1], hash: m[2], animated: m[2].startsWith('a_'), name });
        }
        return out;
      });
    } catch (e) { console.log(`[harvest] batch evaluate err: ${e.message?.slice(0, 80)}`); }
    for (const b of batch) if (!found.has(b.id)) found.set(b.id, b);
    try {
      const scroller = s.page.locator('[class*="scroller"][class*="messages"], div[class*="messagesWrapper"]').first();
      if ((await scroller.count()) > 0) {
        const bb = await scroller.boundingBox();
        if (bb) await humanScroll(s.page, -1400, 3, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 });
        else await humanScroll(s.page, -1400, 3);
      } else {
        await humanScroll(s.page, -1400, 3);
      }
    } catch (e) {
      console.log(`[harvest] scroll err: ${e.message?.slice(0, 80)}`);
      try { await humanScroll(s.page, -1400, 3); } catch (e2) { console.log(`[harvest] retry scroll err: ${e2.message?.slice(0, 80)}`); }
    }
    await humanIdlePause('short');
  }
  return found;
}

async function fetchAvatarBytes(s, url) {
  try {
    const r = await s.page.context().request.get(url);
    if (!r.ok()) return null;
    const buf = await r.body();
    return buf.length;
  } catch (e) { return null; }
}

export async function harvestAfterRegister(s) {
  if (process.env.DISCORD_HARVEST_AFTER_REGISTER !== '1') return;
  try {
    const OUT = path.resolve(process.cwd(), '.work/avatar-survey/data/discord.json');
    const LIMIT = parseInt(process.env.DISCORD_HARVEST_LIMIT || '100', 10);
    const INVITES = (process.env.DISCORD_INVITES || DEFAULT_INVITES).split(',');
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.log(`[harvest] existing read err: ${e.message?.slice(0, 80)}`); }
    const seen = new Set(existing.map(p => String(p.id || p.handle || '').toLowerCase()));
    const need = Math.max(0, LIMIT - existing.length);
    console.log(`[harvest] existing=${existing.length} target=${LIMIT} need=${need}`);
    if (need === 0) return;
    let opened = false;
    for (const inv of INVITES) {
      console.log(`[harvest] joining ${inv}`);
      if (await joinAndOpen(s, inv)) { opened = true; console.log(`[harvest] channel open url=${s.page.url()}`); break; }
      console.log(`[harvest] ${inv}: could not reach a text channel`);
    }
    if (!opened) { console.log('[harvest] no channel reachable, skipping'); return; }
    const found = await scrollAndHarvest(s, need + 40);
    console.log(`[harvest] harvested ${found.size} unique authors from channel`);
    const profiles = [];
    for (const h of found.values()) {
      if (profiles.length >= need) break;
      if (seen.has(h.id.toLowerCase())) continue;
      seen.add(h.id.toLowerCase());
      const ext = h.animated ? 'gif' : 'png';
      const avatarUrl = `https://cdn.discordapp.com/avatars/${h.id}/${h.hash}.${ext}?size=512`;
      const profile = { platform: 'discord', id: h.id, handle: h.name || h.id, display_name: h.name || undefined, bio: undefined, bio_length: 0, has_link_in_bio: false, followers_str: undefined, avatar_url: avatarUrl, avatar_is_default: false };
      const bytes = await fetchAvatarBytes(s, avatarUrl);
      if (bytes != null) profile.avatar_bytes = bytes;
      profiles.push(profile);
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify([...existing, ...profiles], null, 2));
    console.log(`[harvest] wrote ${profiles.length} new profiles (total ${existing.length + profiles.length}) to ${OUT}`);
  } catch (e) { console.log(`[harvest] err: ${e.message?.slice(0, 200)}`); }
}
