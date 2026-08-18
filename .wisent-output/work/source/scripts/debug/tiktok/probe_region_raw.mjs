// Replay the /passport/web/region/ POST manually from inside our session
// and dump the exact response body — to see WHY TikTok's JS interprets it
// as falsy (which causes RegionServiceNoResponseError aka -202).

import { WSession } from '../../../dist/session/wsession.js';
import { generatePersona } from '../../../dist/browser/persona.js';
import { createHash } from 'node:crypto';

const persona = generatePersona({ country: 'US', os: 'windows' });
const s = await WSession.start({ label: 'probe_region_raw', proxy: process.env.PROBE_PROXY || 'residential', persona });

try {
  await s.goto('https://www.tiktok.com/signup/phone-or-email/email');
  await s.wait(5);

  const id = await s.generateIdentity('tiktok');
  const hashedId = createHash('sha256').update(id.email + 'aDy0TUhtql92P7hScCs97YWMT-jub2q9').digest('hex');
  console.log(`[probe] email=${id.email} hashed_id=${hashedId}`);

  const domains = [
    'https://us.tiktok.com',
    'https://login-no1a.www.tiktok.com',
    'https://web-sg.tiktok.com',
  ];

  for (const domain of domains) {
    console.log(`\n=== ${domain}/passport/web/region/ ===`);
    const result = await s.page.evaluate(async (args) => {
      const { domain, hashedId } = args;
      const body = new URLSearchParams({
        hashed_id: hashedId,
        type: '2',
        platform_app_id: '',
        platform_scene: '',
        aid: '1459',
      }).toString();
      const csrfCookie = document.cookie.split('; ').find(c => c.startsWith('passport_csrf_token='));
      const csrf = csrfCookie ? decodeURIComponent(csrfCookie.split('=')[1]) : '';

      try {
        const r = await fetch(`${domain}/passport/web/region/?aid=1988&app_language=en&app_name=tiktok_web`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-tt-passport-csrf-token': csrf,
          },
          body,
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const hdrs = {};
        r.headers.forEach((v, k) => { hdrs[k] = v; });
        return {
          status: r.status,
          csrfUsed: csrf ? csrf.slice(0, 20) : '(none)',
          bodyLen: text.length,
          bodyRaw: text.slice(0, 500),
          json,
          isFalsy: !json,
          hasErrorCode: json?.data?.error_code,
          message: json?.message,
          headers: hdrs,
        };
      } catch (e) {
        return { err: String(e) };
      }
    }, { domain, hashedId });
    console.log(JSON.stringify(result, null, 2).slice(0, 2500));
  }
} catch (e) {
  console.error('ERR:', e.message?.slice(0, 300));
} finally {
  await s.close().catch(() => {});
}
