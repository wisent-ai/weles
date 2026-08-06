#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_HOST = /^[A-Za-z0-9_.:@\[\]-]+$/;
const SAFE_USER = /^[a-z][a-z0-9_-]{0,30}$/;
const SAFE_HOME = /^\/Users\/[a-z][a-z0-9_-]{0,30}$/;
const FLAGS = new Set([
  '--host',
  '--relay-user',
  '--relay-home',
  '--source-user',
  '--source-home',
  '--full-name',
  '--password-stdin',
]);
const FILES = [
  'scripts/auth/apple-challenge-mac-ssh-gate.mjs',
  'scripts/auth/relay-apple-challenge.mjs',
  'scripts/trajectories/apple/native_2fa/native_2fa.mjs',
  'scripts/trajectories/apple/native_2fa/followup_ax_capture.swift',
];

function usage() {
  console.error(
    'Usage: node scripts/auth/bootstrap-apple-relay.mjs '
    + '--host <ssh-destination> --relay-user <user> '
    + '[--relay-home /Users/<user>] [--source-user charles] '
    + '[--source-home /Users/charles] [--full-name "Apple 2FA Relay"] '
    + '[--password-stdin]',
  );
}

function parseFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!FLAGS.has(name) || flags.has(name)) throw new Error(`Invalid flag: ${name ?? '(missing)'}`);
    if (name === '--password-stdin') {
      flags.set(name, 'true');
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeout ?? 60_000,
    maxBuffer: 1024 * 1024,
    stdio: options.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${command} failed${detail ? `: ${detail.slice(0, 1000)}` : ''}`);
  }
  return result;
}

function checkpoint(name, detail) {
  console.log(`[checkpoint] ${name}: ${detail}`);
}

function remoteUserExists(host, user) {
  const result = spawnSync('ssh', [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', host,
    '/usr/bin/id', '-u', user,
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Unable to inspect relay account: ${String(result.stderr || '').trim()}`);
}

function createRemoteUser(host, user, home, fullName, password) {
  if (password.length < 8 || password.length > 1024 || /[\0\r\n]/.test(password)) {
    throw new Error('Relay password must contain 8-1024 characters and no control newlines');
  }
  const script = String.raw`set -eu
USER_NAME=$1
USER_HOME=$2
FULL_NAME=$3
if /usr/bin/id "$USER_NAME" >/dev/null 2>&1; then
  printf 'exists\n'
  exit 0
fi
IFS= read -r PASSWORD
if [ -z "$PASSWORD" ]; then exit 65; fi
/usr/sbin/sysadminctl -addUser "$USER_NAME" -fullName "$FULL_NAME" -home "$USER_HOME" -shell /bin/zsh -password "$PASSWORD" >/dev/null
/usr/sbin/createhomedir -c -u "$USER_NAME" >/dev/null
/usr/bin/id "$USER_NAME" >/dev/null
printf 'created\n'
`;
  const invocation = [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', host,
    'sudo', '-n', '/bin/sh', '-c', script, 'bootstrap-user', user, home, fullName,
  ];
  run('ssh', invocation, { input: `${password}\n`, timeout: 60_000 });
}

const REMOTE_INSTALL = String.raw`set -euo pipefail
RELAY_USER=$1
RELAY_HOME=$2
SOURCE_USER=$3
SOURCE_HOME=$4
ARCHIVE=$5
NODE=/opt/homebrew/bin/node
STATE=/var/db/wisent-apple-relay-bootstrap.json

case "$RELAY_USER" in (*[!a-z0-9_-]*|'') exit 64;; esac
case "$SOURCE_USER" in (*[!a-z0-9_-]*|'') exit 64;; esac
[ "$RELAY_HOME" = "/Users/$RELAY_USER" ] || exit 64
[ "$SOURCE_HOME" = "/Users/$SOURCE_USER" ] || exit 64
/usr/bin/id "$RELAY_USER" >/dev/null
[ -x "$NODE" ]
[ -f "$SOURCE_HOME/weles/var/apple-2fa-relay-config.json" ]

/bin/mkdir -p "$RELAY_HOME/weles" "$RELAY_HOME/weles/var" "$RELAY_HOME/.ssh"
/usr/bin/tar -xf "$ARCHIVE" -C "$RELAY_HOME/weles"
/bin/chmod 755 \
  "$RELAY_HOME/weles/scripts/auth/apple-challenge-mac-ssh-gate.mjs" \
  "$RELAY_HOME/weles/scripts/auth/relay-apple-challenge.mjs"
/bin/chmod 644 \
  "$RELAY_HOME/weles/scripts/trajectories/apple/native_2fa/native_2fa.mjs" \
  "$RELAY_HOME/weles/scripts/trajectories/apple/native_2fa/followup_ax_capture.swift"

SOURCE_CONFIG="$SOURCE_HOME/weles/var/apple-2fa-relay-config.json"
SOURCE_IDENTITY=$("$NODE" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(c.identity_file)' "$SOURCE_CONFIG")
SOURCE_KNOWN_HOSTS=$("$NODE" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(c.known_hosts_file)' "$SOURCE_CONFIG")
case "$SOURCE_IDENTITY" in (/*) ;; (*) exit 65;; esac
case "$SOURCE_KNOWN_HOSTS" in (/*) ;; (*) exit 65;; esac
[ -f "$SOURCE_IDENTITY" ]
[ -f "$SOURCE_KNOWN_HOSTS" ]

TARGET_IDENTITY="$RELAY_HOME/.ssh/apple-2fa-skarbiec"
TARGET_KNOWN_HOSTS="$RELAY_HOME/.ssh/apple-2fa-skarbiec-known-hosts"
/usr/bin/install -m 600 "$SOURCE_IDENTITY" "$TARGET_IDENTITY"
/usr/bin/install -m 600 "$SOURCE_KNOWN_HOSTS" "$TARGET_KNOWN_HOSTS"
"$NODE" -e '
  const fs=require("fs");
  const source=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  source.identity_file=process.argv[3];
  source.known_hosts_file=process.argv[4];
  fs.writeFileSync(process.argv[2], JSON.stringify(source, null, 2)+String.fromCharCode(10), { mode: 0o600 });
' "$SOURCE_CONFIG" "$RELAY_HOME/weles/var/apple-2fa-relay-config.json" "$TARGET_IDENTITY" "$TARGET_KNOWN_HOSTS"
/bin/chmod 600 "$RELAY_HOME/weles/var/apple-2fa-relay-config.json"

SOURCE_AUTHORIZED="$SOURCE_HOME/.ssh/authorized_keys"
TARGET_AUTHORIZED="$RELAY_HOME/.ssh/authorized_keys"
[ -f "$SOURCE_AUTHORIZED" ]
RELAY_KEY=$(/usr/bin/awk '/apple-challenge-mac-ssh-gate[.]mjs/ { print; exit }' "$SOURCE_AUTHORIZED")
[ -n "$RELAY_KEY" ]
RELAY_KEY=$(printf '%s' "$RELAY_KEY" | "$NODE" -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.replace(process.argv[1],process.argv[2])))' "$SOURCE_HOME/weles" "$RELAY_HOME/weles")
/usr/bin/touch "$TARGET_AUTHORIZED"
if ! /usr/bin/awk -v key="$RELAY_KEY" '$0 == key { found=1 } END { exit found ? 0 : 1 }' "$TARGET_AUTHORIZED"; then
  printf '%s\n' "$RELAY_KEY" >> "$TARGET_AUTHORIZED"
fi
/bin/chmod 700 "$RELAY_HOME/.ssh"
/bin/chmod 600 "$TARGET_AUTHORIZED"
/usr/sbin/chown -R "$RELAY_USER":staff "$RELAY_HOME/.ssh" "$RELAY_HOME/weles"

/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -activate -configure -access -on -users "$RELAY_USER" -privs -all -restart -agent >/dev/null

/bin/launchctl asuser "$(/usr/bin/id -u "$RELAY_USER")" "$NODE" \
  --check "$RELAY_HOME/weles/scripts/auth/apple-challenge-mac-ssh-gate.mjs"
/bin/launchctl asuser "$(/usr/bin/id -u "$RELAY_USER")" "$NODE" \
  --check "$RELAY_HOME/weles/scripts/auth/relay-apple-challenge.mjs"
/usr/bin/swiftc -typecheck "$RELAY_HOME/weles/scripts/trajectories/apple/native_2fa/followup_ax_capture.swift"

"$NODE" -e '
  const fs=require("fs");
  const state={
    version:1,
    relay_user:process.argv[2],
    relay_home:process.argv[3],
    source_user:process.argv[4],
    installed_at:new Date().toISOString(),
    checkpoints:["account","artifacts","skarbiec-write-only-key","forced-command","remote-management","syntax"],
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(state, null, 2)+String.fromCharCode(10), { mode: 0o600 });
' "$STATE" "$RELAY_USER" "$RELAY_HOME" "$SOURCE_USER"
/usr/sbin/chown root:wheel "$STATE"
/bin/chmod 600 "$STATE"
/bin/rm -f "$ARCHIVE"
`;

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const host = flags.get('--host') ?? '';
  const relayUser = flags.get('--relay-user') ?? '';
  const sourceUser = flags.get('--source-user') ?? 'charles';
  const relayHome = flags.get('--relay-home') ?? `/Users/${relayUser}`;
  const sourceHome = flags.get('--source-home') ?? `/Users/${sourceUser}`;
  const fullName = flags.get('--full-name') ?? 'Apple 2FA Relay';
  const passwordStdin = flags.has('--password-stdin');

  if (!SAFE_HOST.test(host) || host.startsWith('-')) throw new Error('--host is invalid');
  if (!SAFE_USER.test(relayUser)) throw new Error('--relay-user is invalid');
  if (!SAFE_USER.test(sourceUser)) throw new Error('--source-user is invalid');
  if (!SAFE_HOME.test(relayHome) || relayHome !== `/Users/${relayUser}`) throw new Error('--relay-home must match --relay-user');
  if (!SAFE_HOME.test(sourceHome) || sourceHome !== `/Users/${sourceUser}`) throw new Error('--source-home must match --source-user');
  if (!fullName || fullName.length > 255 || /[\0\r\n]/.test(fullName)) throw new Error('--full-name is invalid');

  run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', host, '/usr/bin/uname', '-s'], { timeout: 30_000 });
  checkpoint('ssh', `connected to ${host}`);

  if (!remoteUserExists(host, relayUser)) {
    if (!passwordStdin) throw new Error('Relay account is missing; rerun with --password-stdin and provide its initial password on stdin');
    const password = readFileSync(0, 'utf8').replace(/\n$/, '');
    createRemoteUser(host, relayUser, relayHome, fullName, password);
  }
  checkpoint('account', `${relayUser} exists`);

  const here = dirname(fileURLToPath(import.meta.url));
  const repository = resolve(here, '..', '..');
  const tempDirectory = mkdtempSync(join(tmpdir(), 'weles-apple-relay-bootstrap-'));
  chmodSync(tempDirectory, 0o700);
  const archive = join(tempDirectory, 'relay.tar');
  const remoteArchive = `/tmp/weles-apple-relay-${process.pid}.tar`;
  try {
    run('/usr/bin/tar', ['-cf', archive, '-C', repository, ...FILES]);
    run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', archive, `${host}:${remoteArchive}`], { timeout: 60_000 });
    checkpoint('artifacts', 'uploaded current relay sources');

    run('ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', host,
      'sudo', '-n', '/bin/bash', '-s', '--', relayUser, relayHome, sourceUser, sourceHome, remoteArchive,
    ], { input: REMOTE_INSTALL, timeout: 180_000 });
    checkpoint('configuration', 'installed forced command and write-only Skarbiec route');
    checkpoint('remote-management', `${relayUser} has isolated screen-control access`);
    checkpoint('verification', 'Node and Swift sources passed remote checks');
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Apple relay bootstrap failed');
  usage();
  process.exitCode = 1;
});
