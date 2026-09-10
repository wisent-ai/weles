import { selectByCapability } from '../../../../dist/proxy/capability.js';
import { resolveProxy } from '../../../../dist/proxy/config.js';

/** The persona country a proxy URL implies, or undefined when it names none. */
export function countryHintFromProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  const cc = String(proxyUrl).toLowerCase().match(/\b(us|uk|gb|br|de|fr|nl|ca|au)\b/)?.[0];
  return cc === 'uk' ? 'gb' : cc;
}

function proxyUrlFromConfig(config) {
  const auth = config.username && config.password
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
    : config.username
      ? `${encodeURIComponent(config.username)}@`
      : '';
  return `${config.protocol}://${auth}${config.host}:${config.port}`;
}

/**
 * The proxy the registration runs through: PANGRAM_REGISTRATION_PROXY_URL when
 * set, else the first ISP provider that passes the pangram_register
 * capability and resolves an exit. Null means direct egress.
 */
export async function selectRegistrationProxy() {
  const explicit = process.env.PANGRAM_REGISTRATION_PROXY_URL;
  if (explicit) {
    const u = new URL(explicit);
    return {
      proxyUrl: explicit,
      proxyConfig: {
        host: u.hostname,
        port: Number(u.port),
        protocol: u.protocol.replace(/:$/, ''),
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      },
    };
  }

  const action = 'pangram_register';
  const targetHost = 'www.pangram.com';
  const country = process.env.PANGRAM_REGISTRATION_COUNTRY || 'us';
  const tried = [];

  for (let i = 0; i < 5; i += 1) {
    const winner = await selectByCapability(action, tried);
    if (!winner) {
      console.log(`[pangram_register] no provider passes capability for ${action}`);
      break;
    }
    const filter = `isp ${winner.provider} ${country}`.trim();
    const pw = await resolveProxy(filter, targetHost);
    if (pw?.server) {
      const u = new URL(pw.server);
      console.log(`[pangram_register] proxy=${u.hostname}:${u.port} provider=${pw.provider || winner.provider}`);
      const proxyConfig = {
        host: u.hostname,
        port: Number(u.port),
        protocol: u.protocol.replace(/:$/, ''),
        username: pw.username,
        password: pw.password,
        country: pw.country,
        provider: pw.provider || winner.provider,
      };
      return {
        proxyUrl: proxyUrlFromConfig(proxyConfig),
        proxyConfig,
      };
    }
    tried.push(winner.provider);
  }
  console.log('[pangram_register] no isp proxy available; registering over direct egress');
  return null;
}
