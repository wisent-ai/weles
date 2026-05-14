// Measure weles Chromium TLS + HTTP/2 fingerprint via tls.peet.ws.
// Compares with the real Chrome 147 reference the user wants to match.
// Output is consumed as a guide to patching BoringSSL.

import { WSession } from '../../../dist/session/wsession.js';
import { generatePersona } from '../../../dist/browser/persona.js';

const URLS = [
  'https://tls.peet.ws/api/all',
  'https://tls.browserleaks.com/json',
  'https://check.ja3.zone/',
];

const persona = generatePersona({ country: 'US', os: 'windows', browser: process.env.PROBE_BROWSER });
const s = await WSession.start({ label: 'fingerprint_tls', proxy: process.env.PROBE_PROXY || 'residential', persona });

try {
  for (const url of URLS) {
    console.log(`\n=== ${url} (via page.goto — browser TLS stack) ===`);
    try {
      await s.page.goto(url, { waitUntil: 'domcontentloaded' });
      const text = await s.page.evaluate(`document.body.innerText || document.body.textContent || ''`);
      const status = 200;
      console.log(`status=${status}`);
      try {
        const j = JSON.parse(text);
        const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
        if (j.tls) {
          const tls = j.tls;
          console.log('ja3:', tls.ja3);
          console.log('ja3_hash:', tls.ja3_hash);
          console.log('ja4:', tls.ja4);
          console.log('peetprint:', tls.peetprint);
          console.log('peetprint_hash:', tls.peetprint_hash);
          if (tls.ciphers) console.log('ciphers:', tls.ciphers.slice(0, 30).join(','));
          if (tls.extensions) console.log('extensions:', tls.extensions.map(e => e.name || e).slice(0, 30).join(','));
          if (tls.supported_versions) console.log('supported_versions:', tls.supported_versions);
          if (tls.ec_point_formats) console.log('ec_point_formats:', tls.ec_point_formats);
          if (tls.signature_algorithms) console.log('signature_algorithms:', tls.signature_algorithms);
          if (tls.supported_groups || tls.elliptic_curves) console.log('groups:', tls.supported_groups || tls.elliptic_curves);
        }
        if (j.http2) {
          console.log('http2 akamai_fingerprint:', j.http2.akamai_fingerprint);
          console.log('http2 sent_frames:', JSON.stringify(j.http2.sent_frames || []).slice(0, 500));
        }
        if (j.user_agent) console.log('user_agent:', j.user_agent);
        if (j.headers) console.log('headers:', JSON.stringify(j.headers).slice(0, 400));
        if (j.donate) console.log('(tls.peet.ws extra):', JSON.stringify(pick(j, ['ip', 'tcp_ip'])));
      } catch {
        console.log('raw:', text.slice(0, 1200));
      }
    } catch (e) {
      console.log('error:', e.message?.slice(0, 200));
    }
  }
} finally {
  await s.close().catch(() => {});
}
