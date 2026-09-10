// App Store Connect: rename an existing app via the ASC API (no browser).
// Apple forbids POST /v1/apps (create) with 403, but updating metadata on an
// existing app works with an App Manager key. The app name lives in
// appInfoLocalizations.name (per locale). This reads the app + its localizations
// and PATCHes the name; pass DRY=1 to only read.
//
// Env: P8_PATH (App Store Connect .p8 key), KID (key id), ISSUER (issuer uuid),
//      BUNDLE (default ai.wisent.swiatowid), NEW_NAME (required unless DRY=1).
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const P8_PATH = process.env.P8_PATH
  || '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/wisent-backend/AuthKey_ZU3882JD2N.p8';
const KID = process.env.KID || 'ZU3882JD2N';
const ISSUER = process.env.ISSUER || '13148f85-32b2-485c-a7ed-3e1805314299';
const BUNDLE = process.env.BUNDLE || 'ai.wisent.swiatowid';
const NEW_NAME = process.env.NEW_NAME;
const DRY = process.env.DRY === '1';
if (!NEW_NAME && !DRY) { console.log('FAIL: NEW_NAME required (or DRY=1)'); process.exit(1); }

const PEM = readFileSync(P8_PATH, 'utf8');
const b = (x) => Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function jwt() {
  const n = Math.floor(Date.now() / 1000);
  const h = b(JSON.stringify({ alg: 'ES256', kid: KID, typ: 'JWT' }));
  const p = b(JSON.stringify({ iss: ISSUER, iat: n, exp: n + 600, aud: 'appstoreconnect-v1' }));
  const sig = crypto.createSign('SHA256').update(`${h}.${p}`).sign({ key: PEM, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b(sig)}`;
}
const H = { Authorization: `Bearer ${jwt()}` };
const API = 'https://api.appstoreconnect.apple.com/v1';

async function api(path, opts = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...H, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { console.log(`HTTP ${r.status} ${opts.method || 'GET'} ${path}: ${t.slice(0, 400)}`); throw new Error(`http ${r.status}`); }
  return j;
}

const apps = await api(`/apps?filter[bundleId]=${encodeURIComponent(BUNDLE)}&limit=5`);
const app = (apps.data || [])[0];
if (!app) { console.log('FAIL: app not found for bundle', BUNDLE); process.exit(1); }
console.log('APP', app.id, '| name:', app.attributes?.name, '| bundle:', app.attributes?.bundleId);

const infos = await api(`/apps/${app.id}/appInfos?limit=10`);
for (const info of infos.data || []) {
  const state = info.attributes?.appStoreState || info.attributes?.state;
  const locs = await api(`/appInfos/${info.id}/appInfoLocalizations?limit=20`);
  for (const loc of locs.data || []) {
    console.log(`  appInfo ${info.id} [${state}] loc ${loc.id} ${loc.attributes?.locale}: name="${loc.attributes?.name}"`);
    if (!DRY && NEW_NAME && loc.attributes?.name !== NEW_NAME) {
      try {
        await api(`/appInfoLocalizations/${loc.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ data: { type: 'appInfoLocalizations', id: loc.id, attributes: { name: NEW_NAME } } }),
        });
        console.log(`    -> renamed loc ${loc.attributes?.locale} to "${NEW_NAME}"`);
      } catch (e) { console.log('    -> PATCH failed:', e.message); }
    }
  }
}
console.log('DONE');
