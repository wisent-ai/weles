#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
const relayScript = join(homedir(), 'weles', 'scripts', 'auth', 'relay-apple-challenge.mjs');
const original = process.env.SSH_ORIGINAL_COMMAND ?? '';
const prefix = `${relayScript} --guard-id `;
const guardId = original.startsWith(prefix) ? original.slice(prefix.length) : '';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guardId)) {
  throw new Error('Unsupported Apple relay SSH command');
}

const configPath = join(homedir(), 'weles', 'var', 'apple-2fa-relay-config.json');
const stat = statSync(configPath);
if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
  throw new Error('Apple relay config must be an owner-only regular file');
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const expectedKeys = ['host', 'identity_file', 'known_hosts_file', 'port', 'remote_skarbiec_command', 'user'];
if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).sort().join(',') !== expectedKeys.join(',')) {
  throw new Error('Invalid Apple relay config');
}
const result = spawnSync(process.execPath, [
  relayScript,
  '--guard-id', guardId.toLowerCase(),
  '--ssh-host', config.host,
  '--ssh-user', config.user,
  '--ssh-port', String(config.port),
  '--ssh-identity-file', config.identity_file,
  '--ssh-known-hosts-file', config.known_hosts_file,
  '--remote-skarbiec-command', config.remote_skarbiec_command,
], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
