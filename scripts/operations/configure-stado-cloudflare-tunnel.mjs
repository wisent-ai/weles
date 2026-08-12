#!/opt/homebrew/bin/node
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const skarbiec = join(home, '.local', 'bin', 'skarbiec');
const stado = join(home, '.stado', 'bin', 'stado');
const vaultFile = join(home, '.stado', 'skarbiec.vault.json');
const environment = {
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  SKARBIEC_VAULT_FILE: vaultFile,
};
const emailResource = 'origin:https://dash.cloudflare.com/email';
const passwordResource = 'origin:https://dash.cloudflare.com/password';
const capabilityHelper = join(import.meta.dirname, 'issue-cloudflare-capabilities-host.sh');

function runSkarbiec(args) {
  return JSON.parse(execFileSync(skarbiec, args, { encoding: 'utf8', env: environment }));
}

execFileSync(stado, [
  'host', 'install-helper', 'charless-mac-mini', capabilityHelper,
  'issue-cloudflare-capabilities-host', '--json',
], { encoding: 'utf8' });
const capabilityReport = JSON.parse(execFileSync(stado, [
  'host', 'run-helper', 'charless-mac-mini',
  'issue-cloudflare-capabilities-host', '--json',
], { encoding: 'utf8' }));
if (capabilityReport.status !== 'completed') {
  throw new Error('remote Cloudflare capability issuance failed');
}
const capabilities = JSON.parse(capabilityReport.stdout);
const emailCapability = capabilities.email.capability_id;
const passwordCapability = capabilities.password.capability_id;
const apiToken = runSkarbiec(['get', 'weles-api-operator']).fields.token;
const reference = (capabilityId, resource) => ({
  capability_id: capabilityId,
  purpose: 'weles.browser.fill',
  resource,
  target: 'weles',
});
const objective = [
  'The Email and Password fields are already securely filled when this objective begins. For the login form, do not click the submit button: first call focus with selector input[name=password], then call press_key with key Enter, and wait for navigation.',
  'If a CAPTCHA or Turnstile appears, call solve_captcha.',
  'Open Zero Trust, then Networks, then Tunnels, and edit tunnel 17010c0f-a708-404c-b2f0-2c60eaf2f866.',
  'Preserve its bobloo.com public hostname but change that hostname service to http://100.120.25.24:3000.',
  'Add or update stado.wisent.com with service http://127.0.0.1:18765.',
  'Save and finish only after both public hostnames are visibly listed with those exact services.',
  'Do not alter any other Cloudflare resource.',
].join(' ');
const body = {
  action: 'generic_browser_task',
  creds: 'redact',
  timeout_ms: '600000',
  params: {
    url: 'https://dash.cloudflare.com/login',
    objective,
    flow_name: 'cloudflare-stado-public-hostname',
    headless: true,
    constraints: {
      credential_prefill: [
        {
          target: 'input[name=email]',
          field_class: 'email',
          capability: reference(emailCapability, emailResource),
        },
        {
          target: 'input[name=password]',
          field_class: 'password',
          capability: reference(passwordCapability, passwordResource),
        },
      ],
      allowed_tunnel_id: '17010c0f-a708-404c-b2f0-2c60eaf2f866',
      allowed_hostnames: ['bobloo.com', 'stado.wisent.com'],
    },
  },
};
const payload = JSON.stringify(body);
const responseBody = await new Promise((resolve, reject) => {
  const request = http.request('http://100.120.25.24:8788/run', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
  }, (incoming) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  request.setTimeout(Number(body.timeout_ms), () => request.destroy(new Error('Weles API request timed out')));
  request.on('error', reject);
  request.end(payload);
});
const result = JSON.parse(responseBody);
console.log(JSON.stringify(result, null, '\t'));
if (result.ok !== true) throw new Error('Cloudflare tunnel operation failed');
