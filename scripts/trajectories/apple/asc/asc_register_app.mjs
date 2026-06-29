// Create the App Store Connect app record for bundle id ai.wisent.swiatowid so
// TestFlight uploads stop failing with -19000 "No suitable application records".
// Builds an ES256 JWT from the App Manager .p8 (passed via env, never committed),
// finds-or-registers the bundle id, then POSTs /v1/apps. Run:
//   ASC_KEY_ID=... ASC_ISSUER=... APPLE_TEAM_ID=... ASC_P8="$(cat key.p8)" node asc_register_app.mjs
import crypto from 'node:crypto';

const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER = process.env.ASC_ISSUER;
const PEM = process.env.ASC_P8;
const TEAM = process.env.APPLE_TEAM_ID;
const BUNDLE = process.env.ASC_BUNDLE || 'ai.wisent.swiatowid';
const NAME = process.env.ASC_APP_NAME || 'Swiatowid';
const SKU = process.env.ASC_SKU || 'swiatowidios2026';
if (!KEY_ID || !ISSUER || !PEM || !TEAM) {
  console.error('Missing one of ASC_KEY_ID / ASC_ISSUER / ASC_P8 / APPLE_TEAM_ID');
  process.exit(2);
}

const b64url = (b) =>
  Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const now = Math.floor(Date.now() / 1000);
const head = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
const pay = b64url(JSON.stringify({ iss: ISSUER, iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' }));
const sig = crypto.createSign('SHA256').update(`${head}.${pay}`).sign({ key: PEM, dsaEncoding: 'ieee-p1363' });
const JWT = `${head}.${pay}.${b64url(sig)}`;
const H = { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' };
const API = 'https://api.appstoreconnect.apple.com';

async function jget(url) {
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { ok: r.ok, status: r.status, j };
}
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { ok: r.ok, status: r.status, j };
}

// 0) sanity: confirm the JWT works at all
let me = await jget(`${API}/v1/apps?limit=1`);
if (!me.ok) {
  console.error('AUTH FAILED', me.status, JSON.stringify(me.j).slice(0, 400));
  process.exit(1);
}
console.log('auth ok; existing apps visible:', (me.j.data || []).length);

// 1) does the app already exist?
let exist = await jget(`${API}/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE)}&limit=10`);
if (exist.ok && (exist.j.data || []).length) {
  console.log('APP_EXISTS', exist.j.data[0].id, exist.j.data[0].attributes?.name);
  process.exit(0);
}

// 2) find or register the bundle id
let bid;
let bl = await jget(`${API}/v1/bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE)}&limit=200`);
const found = bl.ok ? (bl.j.data || []).find((b) => b.attributes?.identifier === BUNDLE) : null;
if (found) {
  bid = found.id;
  console.log('bundleId exists:', bid);
} else {
  const reg = await jpost(`${API}/v1/bundleIds`, {
    data: { type: 'bundleIds', attributes: { identifier: BUNDLE, name: 'Swiatowid', platform: 'IOS', seedId: TEAM } },
  });
  if (!reg.ok) { console.error('bundleId create FAILED', reg.status, JSON.stringify(reg.j).slice(0, 500)); process.exit(1); }
  bid = reg.j.data.id;
  console.log('bundleId registered:', bid);
}

// 3) create the app record
const create = await jpost(`${API}/v1/apps`, {
  data: {
    type: 'apps',
    attributes: { name: NAME, primaryLocale: 'en-US', sku: SKU, bundleId: BUNDLE },
    relationships: { bundleId: { data: { type: 'bundleIds', id: bid } } },
  },
});
if (create.ok) {
  console.log('APP_CREATED', create.j.data?.id, NAME);
  process.exit(0);
}
console.error('app create FAILED', create.status, JSON.stringify(create.j).slice(0, 900));
process.exit(1);
