// Usage: TOKEN=<discord_auth_token> node --env-file=.env scripts/discord_join_servers.mjs
import { WSession } from '../dist/session/wsession.js';

const token = process.env.DISCORD_TOKEN;
if (!token) { console.log('FAIL: set DISCORD_TOKEN env var'); process.exit(1); }

const SERVERS = [
  { code: 'python', name: 'Python' },
  { code: 'javascript', name: 'JavaScript' },
  { code: 'reactjs', name: 'React.js' },
];

// Verify token first
const me = await fetch('https://discord.com/api/v9/users/@me', { headers: { Authorization: token } });
if (!me.ok) { console.log(`FAIL: token invalid (${me.status})`); process.exit(1); }
const user = await me.json();
console.log(`[join] Logged in as: ${user.username}#${user.discriminator} (${user.email})`);

// Join servers via API
for (const srv of SERVERS) {
  const res = await fetch(`https://discord.com/api/v9/invites/${srv.code}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token },
  });
  const data = await res.json().catch(() => ({}));
  console.log(`[join] ${srv.name} (${srv.code}): ${res.status} — ${data.guild?.name ?? data.message ?? 'joined'}`);
  await new Promise(r => setTimeout(r, 3000));  // allow-raw-playwright: polling/rate-limit loop
}

// List guilds
const guilds = await (await fetch('https://discord.com/api/v9/users/@me/guilds', { headers: { Authorization: token } })).json();
console.log(`[join] Member of ${guilds.length} servers:`);
for (const g of guilds) console.log(`  - ${g.name} (${g.id})`);

// Open browser to take screenshots
const s = await WSession.start({ label: 'discord_screenshot', proxy: process.env.PROXY_URL || 'residential' });
try {
  await s.page.evaluate(`localStorage.setItem("token", JSON.stringify(${JSON.stringify(token)}))`);
  await s.goto('https://discord.com/channels/@me');
  await s.wait(10);
  console.log(`[join] Browser at: ${s.page.url?.()}`);
  await s.screenshot('discord_joined_servers');

  // Navigate to first guild channel
  if (guilds.length > 0) {
    await s.goto(`https://discord.com/channels/${guilds[0].id}`);
    await s.wait(5);
    await s.screenshot(`discord_server_${guilds[0].name.replace(/[^a-z0-9]/gi, '_')}`);
  }
  console.log('PASS: screenshots saved');
} finally {
  await s.close();
}
