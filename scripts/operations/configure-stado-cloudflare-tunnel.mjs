#!/opt/homebrew/bin/node
import { execFileSync } from 'node:child_process';
import { chmodSync, constants, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const skarbiec = join(home, '.local', 'bin', 'skarbiec');
const vaultFile = join(home, '.stado', 'skarbiec.vault.json');
const routesFile = join(home, '.stado', 'capability-routes.json');
const environment = {
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  SKARBIEC_VAULT_FILE: vaultFile,
};
const emailResource = 'origin:https://dash.cloudflare.com/email';
const passwordResource = 'origin:https://dash.cloudflare.com/password';

const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
routes[emailResource] = { item: 'platform-admin-cloudflare', field: 'username' };
routes[passwordResource] = { item: 'platform-admin-cloudflare', field: 'password' };
writeFileSync(routesFile, `${JSON.stringify(routes, null, '\t')}\n`);
chmodSync(routesFile, constants.S_IRUSR | constants.S_IWUSR);

function runSkarbiec(args) {
  return JSON.parse(execFileSync(skarbiec, args, { encoding: 'utf8', env: environment }));
}

function issue(resource) {
  return runSkarbiec([
    'capability-issue',
    '--agent', 'weles-credential-worker-local',
    '--purpose', 'weles.browser.fill',
    '--resource', resource,
    '--target', 'weles',
    '--ttl', '900',
    '--max-uses', '1',
  ]).capability_id;
}

const emailCapability = issue(emailResource);
const passwordCapability = issue(passwordResource);
const apiToken = runSkarbiec(['get', 'weles-api-operator']).fields.token;
const reference = (capabilityId, resource) => ({
  capability_id: capabilityId,
  purpose: 'weles.browser.fill',
  resource,
  target: 'weles',
});
const objective = [
  'Sign in to the Cloudflare dashboard using fill_credential for the Email field with the email capability and the Password field with the password capability given in Constraints.',
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
    headless: false,
    constraints: {
      email_capability: reference(emailCapability, emailResource),
      password_capability: reference(passwordCapability, passwordResource),
      allowed_tunnel_id: '17010c0f-a708-404c-b2f0-2c60eaf2f866',
      allowed_hostnames: ['bobloo.com', 'stado.wisent.com'],
    },
  },
};
const response = await fetch('http://100.120.25.24:8788/run', {
  method: 'POST',
  headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const result = await response.json();
console.log(JSON.stringify(result, null, '\t'));
if (!response.ok || result.ok !== true) throw new Error('Cloudflare tunnel operation failed');
