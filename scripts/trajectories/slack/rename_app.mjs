// Rename a Slack app (display name + bot display name) via the official
// apps.manifest API — no browser, no cookies. Requires an App Configuration
// Token (xoxe…), generated at https://api.slack.com/apps under "Your App
// Configuration Tokens". The bot xoxb token cannot do this (not_allowed_token_type).
//
// Env: SLACK_CONFIG_TOKEN (xoxe…, required), APP_ID (default A0B5UP3MRPT = Swiatowid),
//      NEW_NAME (default Oko).
const TOKEN = process.env.SLACK_CONFIG_TOKEN || '';
const APP_ID = process.env.APP_ID || 'A0B5UP3MRPT';
const NEW_NAME = process.env.NEW_NAME || 'Oko';
if (!TOKEN) { console.log('FAIL: SLACK_CONFIG_TOKEN required (xoxe… from api.slack.com/apps)'); process.exit(2); }

async function call(method, form) {
  const body = new URLSearchParams({ token: TOKEN, ...form });
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const j = await r.json();
  if (!j.ok) { console.log(`FAIL ${method}: ${JSON.stringify(j).slice(0, 400)}`); process.exit(1); }
  return j;
}

const exp = await call('apps.manifest.export', { app_id: APP_ID });
const manifest = exp.manifest;
const oldName = manifest?.display_information?.name;
const oldBot = manifest?.features?.bot_user?.display_name;
console.log(`current: name="${oldName}" bot_display_name="${oldBot}"`);

manifest.display_information.name = NEW_NAME;
if (manifest.features?.bot_user) manifest.features.bot_user.display_name = NEW_NAME;

await call('apps.manifest.update', { app_id: APP_ID, manifest: JSON.stringify(manifest) });
const after = await call('apps.manifest.export', { app_id: APP_ID });
console.log(`updated: name="${after.manifest?.display_information?.name}" bot_display_name="${after.manifest?.features?.bot_user?.display_name}"`);
console.log('DONE');
