// App Store Connect: list (and optionally revoke) signing certificates via the
// ASC API — no browser. xcodebuild -allowProvisioningUpdates fails with "your
// account has reached the maximum number of certificates" when the team's cert
// cap is hit; this shows what exists so a stale/expired one can be freed.
//
// Env: P8_PATH or ASC_P8 (key PEM), KID (default ZA9F7Q6KQZ), ISSUER (default team issuer).
//      REVOKE=<certificateId> to delete one certificate (otherwise read-only).
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const KID = process.env.KID || 'ZA9F7Q6KQZ';
const ISSUER = process.env.ISSUER || '13148f85-32b2-485c-a7ed-3e1805314299';
const PEM = process.env.ASC_P8 || readFileSync(process.env.P8_PATH || '/tmp/asc_working_key.pem', 'utf8');
const REVOKE = process.env.REVOKE;

const b = (x) => Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const n = Math.floor(Date.now() / 1000);
const h = b(JSON.stringify({ alg: 'ES256', kid: KID, typ: 'JWT' }));
const p = b(JSON.stringify({ iss: ISSUER, iat: n, exp: n + 600, aud: 'appstoreconnect-v1' }));
const sig = crypto.createSign('SHA256').update(`${h}.${p}`).sign({ key: PEM, dsaEncoding: 'ieee-p1363' });
const JWT = `${h}.${p}.${b(sig)}`;
const API = 'https://api.appstoreconnect.apple.com/v1';

async function api(path, opts = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = await r.text();
  if (!r.ok) { console.log(`HTTP ${r.status} ${opts.method || 'GET'} ${path}: ${t.slice(0, 300)}`); throw new Error(`http ${r.status}`); }
  return t ? JSON.parse(t) : {};
}

if (process.env.EXPIRE_BUILD) {
  const id = process.env.EXPIRE_BUILD;
  await api(`/builds/${id}`, { method: 'PATCH', body: JSON.stringify({ data: { type: 'builds', id, attributes: { expired: true } } }) });
  console.log('EXPIRED build', id);
} else if (process.env.ASC_PATH) {
  const j = await api(process.env.ASC_PATH);
  console.log(JSON.stringify(j, null, 2).slice(0, 6000));
} else if (REVOKE) {
  await api(`/certificates/${REVOKE}`, { method: 'DELETE' });
  console.log('REVOKED', REVOKE);
} else {
  const j = await api('/certificates?limit=200');
  const rows = (j.data || []).map((c) => ({
    id: c.id,
    type: c.attributes?.certificateType,
    name: c.attributes?.displayName,
    expiry: c.attributes?.expirationDate,
  }));
  rows.sort((a, b2) => (a.type || '').localeCompare(b2.type || ''));
  console.log(`TOTAL ${rows.length} certificates`);
  for (const r of rows) console.log(`${r.id}\t${r.type}\t${r.expiry}\t${r.name}`);
}
