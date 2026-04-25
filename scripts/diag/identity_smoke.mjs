// Verify the register-time identity persistence change.
// Launches WSession.start with proxy=residential and no persona, then reads
// ws.proxyConfig + ws.personaConfig off the live session and prints what
// saveAccount() would write to metadata. Does not POST to social_accounts.
import { WSession } from '../../dist/session/wsession.js';

const s = await WSession.start({ label: 'identity_smoke', proxy: 'residential' });
try {
  const ok = !!s.proxyConfig && !!s.personaConfig && !!s.proxyConfig.country && !!s.personaConfig.os;
  console.log('proxyConfig:', JSON.stringify({
    server: s.proxyConfig?.server,
    username_head: s.proxyConfig?.username?.slice(0, 60),
    has_password: !!s.proxyConfig?.password,
    country: s.proxyConfig?.country,
  }, null, 2));
  console.log('personaConfig:', JSON.stringify({
    os: s.personaConfig?.os,
    browser: s.personaConfig?.browser,
    platform: s.personaConfig?.platform,
    language: s.personaConfig?.language,
    timezone: s.personaConfig?.timezone,
    chromeVersion: s.personaConfig?.chromeVersion,
    gpu: s.personaConfig?.gpu,
    screen: s.personaConfig?.screen,
    canvasSeed: s.personaConfig?.canvasSeed,
    audioSampleRate: s.personaConfig?.audioSampleRate,
    hardwareConcurrency: s.personaConfig?.hardwareConcurrency,
  }, null, 2));
  const atomNames = 'waitFor,fillSelector,writeBanSignal,dismissCookieBanner,dwell,patchAccount,isLoggedOut'.split(',');
  const missingAtoms = atomNames.filter(n => typeof s[n] !== 'function');
  console.log(missingAtoms.length === 0 ? `atoms: all ${atomNames.length} installed` : `atoms MISSING: ${missingAtoms.join(',')}`);
  const overallOk = ok && missingAtoms.length === 0;
  console.log(overallOk ? 'OK: both stamped, country propagated, atoms installed' : 'FAIL: missing fields or atoms');
  process.exitCode = overallOk ? 0 : 1;
} finally {
  await s.close();
}
