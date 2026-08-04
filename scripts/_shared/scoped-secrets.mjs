import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lstatSync } from 'node:fs';

const LOGIN_FIELDS = Object.freeze({ username: true, password: true });
const LOGIN_WITH_TOTP_FIELDS = Object.freeze({ username: true, password: true, totp_secret: true });
const BASIC_PROXY_FIELDS = Object.freeze({ username: true, password: true });
const ENDPOINT_PROXY_FIELDS = Object.freeze({ username: true, password: true, host: true, ports: true });
const API_KEY_FIELDS = Object.freeze({ api_key: true });

const SERVICES = Object.freeze({
  googleSso: Object.freeze({ consumer: 'weles-google-sso-client', item: 'weles-google-sso-login', tokenFile: 'weles-google-sso-client-skarbiec-token', fields: LOGIN_FIELDS }),
  googleAds: Object.freeze({ consumer: 'weles-google-ads-client', item: 'weles-google-ads-login', tokenFile: 'weles-google-ads-client-skarbiec-token', writerConsumer: 'weles-google-ads-writer', writerTokenFile: 'weles-google-ads-writer-skarbiec-token', fields: LOGIN_WITH_TOTP_FIELDS }),
  gmail: Object.freeze({ consumer: 'weles-gmail-client', item: 'weles-gmail-login', tokenFile: 'weles-gmail-client-skarbiec-token', fields: LOGIN_WITH_TOTP_FIELDS }),
  googleDrive: Object.freeze({ consumer: 'weles-google-drive-client', item: 'weles-google-drive-login', tokenFile: 'weles-google-drive-client-skarbiec-token', fields: LOGIN_WITH_TOTP_FIELDS }),
  googleWorkspaceAdmin: Object.freeze({ consumer: 'weles-google-workspace-admin-client', item: 'weles-google-workspace-admin-login', tokenFile: 'weles-google-workspace-admin-client-skarbiec-token', fields: LOGIN_WITH_TOTP_FIELDS }),
  oxylabsDashboard: Object.freeze({ consumer: 'weles-oxylabs-dashboard-client', item: 'weles-oxylabs-dashboard-login', tokenFile: 'weles-oxylabs-dashboard-client-skarbiec-token', fields: LOGIN_WITH_TOTP_FIELDS }),
  brightdataDashboard: Object.freeze({ consumer: 'weles-brightdata-dashboard-client', item: 'weles-brightdata-dashboard-login', tokenFile: 'weles-brightdata-dashboard-client-skarbiec-token', fields: LOGIN_WITH_TOTP_FIELDS }),
  brightdataBrowser: Object.freeze({ consumer: 'weles-brightdata-browser-client', item: 'weles-brightdata-browser', tokenFile: 'weles-brightdata-browser-client-skarbiec-token', fields: Object.freeze({ websocket_url: true }) }),
  umamiDashboard: Object.freeze({ consumer: 'weles-umami-dashboard-client', item: 'weles-umami-dashboard-login', tokenFile: 'weles-umami-dashboard-client-skarbiec-token', fields: LOGIN_WITH_TOTP_FIELDS }),
  linearDashboard: Object.freeze({ consumer: 'weles-linear-dashboard-client', item: 'weles-linear-dashboard-login', tokenFile: 'weles-linear-dashboard-client-skarbiec-token', fields: LOGIN_WITH_TOTP_FIELDS }),
  vastDashboard: Object.freeze({ consumer: 'weles-vast-dashboard-client', item: 'weles-vast-dashboard-login', tokenFile: 'weles-vast-dashboard-client-skarbiec-token', fields: LOGIN_FIELDS }),
  supabaseDashboard: Object.freeze({ consumer: 'weles-supabase-dashboard-client', item: 'weles-supabase-dashboard-login', tokenFile: 'weles-supabase-dashboard-client-skarbiec-token', fields: LOGIN_FIELDS }),
  appleAppStoreConnectApi: Object.freeze({ consumer: 'weles-apple-app-store-connect-api-client', item: 'weles-apple-app-store-connect-api', tokenFile: 'weles-apple-app-store-connect-api-client-skarbiec-token', fields: Object.freeze({ key_id: true, issuer_id: true, private_key: true, team_id: true }) }),
  oxylabsResidential: Object.freeze({ consumer: 'weles-oxylabs-residential-proxy-client', item: 'weles-oxylabs-residential-proxy', tokenFile: 'weles-oxylabs-residential-proxy-client-skarbiec-token', fields: BASIC_PROXY_FIELDS }),
  oxylabsMobile: Object.freeze({ consumer: 'weles-oxylabs-mobile-proxy-client', item: 'weles-oxylabs-mobile-proxy', tokenFile: 'weles-oxylabs-mobile-proxy-client-skarbiec-token', writerConsumer: 'weles-oxylabs-mobile-proxy-writer', writerTokenFile: 'weles-oxylabs-mobile-proxy-writer-skarbiec-token', fields: BASIC_PROXY_FIELDS }),
  oxylabsIsp: Object.freeze({ consumer: 'weles-oxylabs-isp-proxy-client', item: 'weles-oxylabs-isp-proxy', tokenFile: 'weles-oxylabs-isp-proxy-client-skarbiec-token', writerConsumer: 'weles-oxylabs-isp-proxy-writer', writerTokenFile: 'weles-oxylabs-isp-proxy-writer-skarbiec-token', fields: ENDPOINT_PROXY_FIELDS }),
  oxylabsDedicatedIsp: Object.freeze({ consumer: 'weles-oxylabs-dedicated-isp-proxy-client', item: 'weles-oxylabs-dedicated-isp-proxy', tokenFile: 'weles-oxylabs-dedicated-isp-proxy-client-skarbiec-token', writerConsumer: 'weles-oxylabs-dedicated-isp-proxy-writer', writerTokenFile: 'weles-oxylabs-dedicated-isp-proxy-writer-skarbiec-token', fields: ENDPOINT_PROXY_FIELDS }),
  brightdataProxy: Object.freeze({ consumer: 'weles-brightdata-proxy-client', item: 'weles-brightdata-proxy', tokenFile: 'weles-brightdata-proxy-client-skarbiec-token', fields: Object.freeze({ username: true, password: true, zone: true }) }),
  antiCaptcha: Object.freeze({ consumer: 'weles-anti-captcha-client', item: 'weles-anti-captcha-api', tokenFile: 'weles-anti-captcha-client-skarbiec-token', fields: API_KEY_FIELDS }),
  twoCaptcha: Object.freeze({ consumer: 'weles-two-captcha-client', item: 'weles-two-captcha-api', tokenFile: 'weles-two-captcha-client-skarbiec-token', fields: API_KEY_FIELDS }),
  capsolver: Object.freeze({ consumer: 'weles-capsolver-client', item: 'weles-capsolver-api', tokenFile: 'weles-capsolver-client-skarbiec-token', fields: API_KEY_FIELDS }),
  capmonster: Object.freeze({ consumer: 'weles-capmonster-client', item: 'weles-capmonster-api', tokenFile: 'weles-capmonster-client-skarbiec-token', fields: API_KEY_FIELDS }),
  noCaptcha: Object.freeze({ consumer: 'weles-nocaptcha-client', item: 'weles-nocaptcha-api', tokenFile: 'weles-nocaptcha-client-skarbiec-token', fields: API_KEY_FIELDS }),
  nopecha: Object.freeze({ consumer: 'weles-nopecha-client', item: 'weles-nopecha-api', tokenFile: 'weles-nopecha-client-skarbiec-token', fields: API_KEY_FIELDS }),
  resendReceiving: Object.freeze({ consumer: 'weles-resend-receiving-client', item: 'weles-resend-receiving-api', tokenFile: 'weles-resend-receiving-client-skarbiec-token', fields: API_KEY_FIELDS }),
  resendManagement: Object.freeze({ consumer: 'weles-resend-management-client', item: 'weles-resend-management-api', tokenFile: 'weles-resend-management-client-skarbiec-token', fields: API_KEY_FIELDS }),
  juicySms: Object.freeze({ consumer: 'weles-juicysms-client', item: 'weles-juicysms-api', tokenFile: 'weles-juicysms-client-skarbiec-token', fields: API_KEY_FIELDS }),
  smsActivate: Object.freeze({ consumer: 'weles-sms-activate-client', item: 'weles-sms-activate-api', tokenFile: 'weles-sms-activate-client-skarbiec-token', fields: API_KEY_FIELDS }),
  discordBot: Object.freeze({ consumer: 'weles-discord-bot-client', item: 'weles-discord-bot', tokenFile: 'weles-discord-bot-client-skarbiec-token', fields: API_KEY_FIELDS }),
});

function checkedEndpoint() {
  const raw = String(process.env.WELES_SKARBIEC_URL || '').trim();
  if (!raw) throw new Error('WELES_SKARBIEC_URL is required for scoped secret resolution');
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('WELES_SKARBIEC_URL is invalid');
  }
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) {
    throw new Error('WELES_SKARBIEC_URL must use HTTPS or authenticated loopback HTTP');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('WELES_SKARBIEC_URL must not contain credentials, query, or fragment');
  }
  return endpoint.toString().replace(/\/$/, '');
}

function checkedTokenFile(fileName) {
  const path = join(homedir(), '.stado', fileName);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`required scoped Skarbiec token file is unavailable for ${fileName}`);
  }
  const unsafeBits = Number.parseInt('77', Number('8'));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & unsafeBits) !== Number('0')) {
    throw new Error(`refusing unsafe scoped Skarbiec token file for ${fileName}`);
  }
  return path;
}

function stadoBinary() {
  return process.env.WELES_STADO_BIN || join(homedir(), '.stado', 'bin', 'stado');
}

function acquisitionPaths() {
  return {
    helper: join(homedir(), 'weles', 'scripts', 'worker', 'deploy', 'skarbiec-acquire.mjs'),
    scopes: join(homedir(), 'weles', 'scripts', 'worker', 'deploy', 'skarbiec-acquisition-scopes.conf'),
  };
}

function workloadEnvironment() {
  const workloadId = String(process.env.SKARBIEC_WORKLOAD_ID || '').trim();
  const signingKeyFile = String(process.env.SKARBIEC_WORKLOAD_SIGNING_KEY_FILE || '').trim();
  if (!workloadId || !signingKeyFile) {
    throw new Error('Skarbiec workload identity is required for scoped secret acquisition');
  }
  return { workloadId, signingKeyFile };
}

export function readScopedSecret(serviceName, field) {
  const service = SERVICES[serviceName];
  if (!service) throw new Error(`unknown Weles scoped secret service: ${serviceName}`);
  if (!Object.prototype.hasOwnProperty.call(service.fields, field)) throw new Error(`field is not in the exact Weles scoped secret contract: ${serviceName}/${field}`);
  const consumer = `${service.consumer}-${field}`;
  const { helper, scopes } = acquisitionPaths();
  const { workloadId, signingKeyFile } = workloadEnvironment();
  const result = spawnSync(process.execPath, [
    helper,
    checkedEndpoint(),
    scopes,
    consumer,
    service.item,
    field,
  ], {
    encoding: 'buffer',
    maxBuffer: Number('65536'),
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      HOME: homedir(),
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      SKARBIEC_WORKLOAD_ID: workloadId,
      SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: signingKeyFile,
    },
  });
  const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(Number('0'));
  try {
    if (result.error || result.status !== Number('0')) throw new Error(`scoped Skarbiec read failed for ${serviceName}/${field}`);
    const value = output.toString('utf8').replace(/[\r\n]+$/, '');
    if (!value || /[\r\n]/.test(value) || value.includes(String.fromCharCode(Number('0')))) {
      throw new Error(`scoped Skarbiec returned an invalid value for ${serviceName}/${field}`);
    }
    return value;
  } finally {
    output.fill(Number('0'));
  }
}

export function assertScopedSecretWriter(serviceName) {
  const service = SERVICES[serviceName];
  if (!service?.writerConsumer || !service?.writerTokenFile) {
    throw new Error(`no exact Weles scoped secret writer contract exists for ${serviceName}`);
  }
  checkedEndpoint();
  checkedTokenFile(service.writerTokenFile);
}

export function writeScopedSecretItem(serviceName, fields) {
  const service = SERVICES[serviceName];
  if (!service) throw new Error(`unknown Weles scoped secret service: ${serviceName}`);
  assertScopedSecretWriter(serviceName);
  const entries = Object.entries(fields || {});
  if (entries.length !== Object.keys(service.fields).length
      || entries.some(([field]) => !Object.prototype.hasOwnProperty.call(service.fields, field))) {
    throw new Error(`write does not match the exact Weles scoped secret contract for ${serviceName}`);
  }
  const normalized = {};
  for (const [field, rawValue] of entries) {
    const value = String(rawValue ?? '').trim();
    if (!value || /[\r\n]/.test(value) || value.includes(String.fromCharCode(Number('0')))) {
      throw new Error(`refusing invalid scoped secret write for ${serviceName}/${field}`);
    }
    normalized[field] = value;
  }
  const input = Buffer.from(JSON.stringify(normalized));
  try {
    const result = spawnSync(stadoBinary(), ['secrets', 'put', service.item], {
      input,
      maxBuffer: Number('65536'),
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        HOME: homedir(),
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        WC_SKARBIEC_URL: checkedEndpoint(),
        WC_SKARBIEC_CONSUMER: service.writerConsumer,
        WC_SKARBIEC_TOKEN_FILE: checkedTokenFile(service.writerTokenFile),
      },
    });
    if (result.error || result.status !== Number('0')) {
      throw new Error(`scoped Skarbiec write failed for ${serviceName}`);
    }
  } finally {
    input.fill(Number('0'));
  }
}

export function writeScopedLogin(serviceName, login) {
  const service = SERVICES[serviceName];
  if (!service
      || !Object.prototype.hasOwnProperty.call(service.fields, 'username')
      || !Object.prototype.hasOwnProperty.call(service.fields, 'password')) {
    throw new Error(`service is not an exact Weles scoped login contract: ${serviceName}`);
  }
  writeScopedSecretItem(serviceName, {
    username: login?.email,
    password: login?.password,
    ...(Object.prototype.hasOwnProperty.call(service.fields, 'totp_secret')
      ? { totp_secret: login?.totpSecret }
      : {}),
  });
}

export function readScopedLogin(serviceName) {
  const service = SERVICES[serviceName];
  if (!service
      || !Object.prototype.hasOwnProperty.call(service.fields, 'username')
      || !Object.prototype.hasOwnProperty.call(service.fields, 'password')) {
    throw new Error(`service is not an exact Weles scoped login contract: ${serviceName}`);
  }
  const email = readScopedSecret(serviceName, 'username');
  const password = readScopedSecret(serviceName, 'password');
  const totpSecret = Object.prototype.hasOwnProperty.call(service.fields, 'totp_secret')
    ? readScopedSecret(serviceName, 'totp_secret')
    : undefined;
  return { email, password, ...(totpSecret ? { totpSecret } : {}) };
}

export function readScopedProxy(serviceName) {
  return {
    username: readScopedSecret(serviceName, 'username'),
    password: readScopedSecret(serviceName, 'password'),
  };
}
