#!/opt/homebrew/bin/node
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const skarbiec = join(home, '.stado', 'bin', 'skarbiec');
const vaultFile = join(home, '.stado', 'skarbiec.vault.json');
const environment = {
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  SKARBIEC_VAULT_FILE: vaultFile,
};

function runSkarbiec(args) {
  return JSON.parse(execFileSync(skarbiec, args, { encoding: 'utf8', env: environment }));
}

const apiToken = runSkarbiec(['get', 'weles-api-operator']).fields.token;
const accountId = '35acdbe68affc7b249aa289cd2a21130';
const tunnelId = 'd16253a5-1d70-4d32-876a-b483a6c0004a';
const tunnelUrl = `https://dash.cloudflare.com/${accountId}/tunnels/${tunnelId}`;
const objective = [
  `Open ${tunnelUrl} directly and edit the existing wisent-backend-rtx tunnel.`,
  'Open its Public Hostnames configuration.',
  'Add or update brama.wisent.ai with service type HTTP and URL 127.0.0.1:8080.',
  'Preserve every existing public hostname and its service unchanged.',
  'Save and finish only after brama.wisent.ai is visibly listed with service http://127.0.0.1:8080.',
  'Do not alter any other Cloudflare resource.',
].join(' ');
const body = {
  action: 'generic_keeper_task',
  creds: 'redact',
  timeout_ms: '1800000',
  params: {
    url: tunnelUrl,
    objective,
    flow_name: 'cloudflare-brama-public-hostname',
    headless: false,
    constraints: {
      cookie_consent_buttons: ['Reject All But Necessary', 'Confirm My Choices'],
      cloudflare_login: true,
      account_email: 'lukasz.bartoszcze@gmail.com',
      allowed_tunnel_id: tunnelId,
      allowed_hostnames: ['brama.wisent.ai'],
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
  request.setTimeout(Number(body.timeout_ms) + Number('60000'), () => request.destroy(new Error('Weles API request timed out')));
  request.on('error', reject);
  request.end(payload);
});
const result = JSON.parse(responseBody);
console.log(JSON.stringify(result, null, '\t'));
if (result.ok !== true) throw new Error('Cloudflare tunnel operation failed');
