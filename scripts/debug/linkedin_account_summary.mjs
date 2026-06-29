import { getSocialAccount } from '../../dist/utils/credentials.js';

const acct = await getSocialAccount('linkedin');
if (!acct) {
  console.log('no active linkedin account');
  process.exit(1);
}

const metadata = acct.metadata || {};
console.log(JSON.stringify({
  id: acct.id,
  username: acct.username,
  email: metadata.email || null,
  hasPassword: Boolean(metadata.password),
  hasCookies: Array.isArray(metadata.cookies) && metadata.cookies.length > 0,
  hasProxy: Boolean(metadata.proxy),
  proxyHost: (() => {
    try { return metadata.proxy ? new URL(metadata.proxy).hostname : null; } catch { return 'invalid'; }
  })(),
  personaPresent: Boolean(metadata.persona),
  metadataKeys: Object.keys(metadata).sort(),
}, null, 2));
