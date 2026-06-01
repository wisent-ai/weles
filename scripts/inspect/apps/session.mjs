// Auth-session minter for weles testing mode. Produces a Playwright
// storageState for a whitelisted Wisent-app Supabase user so run.mjs can test
// auth-gated routes (e.g. /assistants/trading).
//
// The app uses @supabase/ssr (cookie session) with PKCE, so an admin magic
// LINK can't be exchanged in-browser (no code_verifier) and the app falls back
// to an anonymous user. Instead we verify the magic-link OTP server-side to get
// a real session for the target user, then write the exact @supabase/ssr cookie
// (base64url(JSON.stringify(session)) under sb-<ref>-auth-token).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... \
//   node scripts/inspect/apps/session.mjs --email <whitelisted@email> \
//        [--domain app.wisent.com] [--out <file>]

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const EMAIL = opt('--email', '');
const DOMAIN = opt('--domain', 'app.wisent.com');
const OUTDIR = '.work/inspect/storage';
const OUT = opt('--out', `${OUTDIR}/session.json`);
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!EMAIL) { console.error('--email <whitelisted email> required'); process.exit(2); }
if (!SUPABASE_URL || !SERVICE_ROLE || !ANON) { console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY env required'); process.exit(2); }
if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });

const ref = new globalThis.URL(SUPABASE_URL).hostname.split('.')[0];

// 1. Admin: mint a magic-link OTP for the (existing) user.
const genRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
  method: 'POST',
  headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
});
const gen = await genRes.json();
if (!genRes.ok || !gen.email_otp) {
  console.error(`generate_link failed ${genRes.status}: ${JSON.stringify(gen).slice(0, 400)}`);
  process.exit(1);
}

// 2. Verify the OTP server-side to obtain a real session for THIS user.
const verRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email: EMAIL, token: gen.email_otp }),
});
const session = await verRes.json();
if (!verRes.ok || !session.access_token || !session.user) {
  console.error(`verify failed ${verRes.status}: ${JSON.stringify(session).slice(0, 400)}`);
  process.exit(1);
}
console.log(`[session] verified ${EMAIL} -> user.id=${session.user.id} (ref=${ref})`);

// 3. Build the @supabase/ssr cookie: base64-<base64url(JSON.stringify(session))>,
//    chunked into .0/.1/... if it exceeds the 3180-char limit.
const payload = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
const name = `sb-${ref}-auth-token`;
const CHUNK = 3180;
const cookieBase = { domain: DOMAIN, path: '/', expires: session.expires_at, httpOnly: false, secure: true, sameSite: 'Lax' };
const cookies = [];
if (payload.length <= CHUNK) {
  cookies.push({ name, value: payload, ...cookieBase });
}
if (payload.length > CHUNK) {
  let i = 0;
  while (i * CHUNK < payload.length) {
    cookies.push({ name: `${name}.${i}`, value: payload.slice(i * CHUNK, (i + 1) * CHUNK), ...cookieBase });
    i += 1;
  }
}

writeFileSync(OUT, JSON.stringify({ cookies, origins: [] }, null, 2));
console.log(`[session] wrote ${cookies.length} cookie(s) -> ${OUT}`);
