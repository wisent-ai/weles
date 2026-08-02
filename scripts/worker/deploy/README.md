# Weles worker — VM deployment

Runs `node scripts/worker/run.mjs` as a systemd service. Drains
`account_action_logs` rows the content-platform campaign scheduler + lifecycle
sim crons enqueue.

## Host prerequisites

- Ubuntu 22.04+ (or any systemd host)
- Node.js 22+, git, gh (GitHub CLI), xvfb
- A Chromium binary — either the custom weles Chromium (per-platform prebuilt
  via `scripts/chromium/download.sh` when the Linux asset exists on the release)
  or Playwright's bundled Chromium at
  `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`
  (`npx playwright install chromium --with-deps`)

## Immutable worker release

Production worker bytes are published only by this repository under
`worker-vX.Y.Z` GitHub Releases. The tag must equal `worker-v` plus the
`package.json` version. Each release contains
`weles-worker-X.Y.Z.tar.gz`, its SHA-256 sidecar, and embedded provenance.

Install an exact release rather than a moving branch:

```bash
version=0.4.0
mkdir -p ~/weles-release && cd ~/weles-release
gh release download "worker-v$version" --repo wisent-ai/weles \
  --pattern "weles-worker-$version.tar.gz*"
shasum -a 256 -c "weles-worker-$version.tar.gz.sha256"
tar -xzf "weles-worker-$version.tar.gz"
cd weles-worker
npm ci
```

No worker release is delegated to Stado, a browser repository, Skarbiec, or
another product channel. Browser and secret integrations retain their own
release and provisioning paths.

## Development checkout

```bash
git clone https://github.com/wisent-ai/weles.git ~/weles
cd ~/weles
npm install
npm run build
```

## Credentials (VM-local, not committed)

```bash
mkdir -p ~/weles/var
cat > ~/weles/var/worker.env <<EOF
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
CRON_SECRET=<same value as content-platform Vercel env>
CHROMIUM_PATH=/home/<user>/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome
LLM_GENERATE_URL=https://content.wisent.ai/api/llm/generate
INSTANCE_ID=<hostname>-worker
RECORDINGS_ROOT=/home/<user>/weles/recordings
WELES_PLACEMENT_MODE=required
WELES_PLACEMENT_POLICY_FILE=/etc/weles/placement-policy.json
EOF
chmod 600 ~/weles/var/worker.env
```

## Product-owned placement policy

Production workers fail closed unless their normalized OS hostname resolves to
exactly one entry in the local Weles placement document. The host operator owns
this non-secret file independently of fleet control planes:

```json
{
  "schema_version": 1,
  "hosts": [{
    "hostname": "browser-worker-1.local",
    "aliases": ["browser-worker-1"],
    "enabled": true,
    "actions": ["generic_browser_task"]
  }]
}
```

Use `actions: ["*"]` for every dispatchable action. Exact action lists
partition work; overlaps intentionally load-share through the existing
conditional `queued` to `running` claim. Set `enabled: false` to drain new
claims. Missing, invalid, ambiguous, or unreadable policy denies claims.
Changes propagate within 30 seconds.

Install the tracked example as an operator-owned file, then edit its hostname
and action assignment:

```bash
sudo install -d -m 0755 /etc/weles
sudo install -m 0644 scripts/worker/deploy/placement-policy.example.json \
  /etc/weles/placement-policy.json
```

Keep Supabase and browser credentials only in the host-local `worker.env`;
placement policy is non-secret and must never contain credentials.

## Install the launch wrapper + unit

```bash
sudo install -m 0755 ~/weles/scripts/worker/deploy/launch.sh /usr/local/bin/weles-worker-launch
sudo cp ~/weles/scripts/worker/deploy/systemd.service /etc/systemd/system/weles-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now weles-worker
```

## macOS worker + auto-deploy

The Mac mini runs the same worker through launchd. The tracked files are:

- `launch-mac.sh`: sources `~/weles/var/worker.env`, sets Homebrew `PATH`, and
  execs `/opt/homebrew/bin/node` under `caffeinate`.
- `com.wisent.weles-worker.plist`: launchd job for `launch-mac.sh`.
- `com.wisent.weles-auto-deploy.plist`: 60-second poller that runs
  `auto-deploy.sh`.

Install or repair the launchd files from a clone on the Mac mini:

```bash
mkdir -p ~/Library/LaunchAgents ~/weles/var
chmod +x ~/weles/scripts/worker/deploy/launch-mac.sh
cp ~/weles/scripts/worker/deploy/com.wisent.weles-worker.plist ~/Library/LaunchAgents/com.wisent.weles-worker.plist
cp ~/weles/scripts/worker/deploy/com.wisent.weles-auto-deploy.plist ~/Library/LaunchAgents/com.wisent.weles-auto-deploy.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.wisent.weles-worker.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.wisent.weles-auto-deploy.plist
```

`auto-deploy.sh` now also refreshes the worker plist from the repo before each
restart, so the Mac mini no longer depends on an untracked local worker wrapper.
The tracked Weles HTTP API provides the control plane for the worker LaunchAgent.
Lifecycle routes require `WELES_API_TOKEN` even when general trajectory routes
allow unauthenticated access:

```bash
curl -fsS -H "Authorization: Bearer $WELES_API_TOKEN" \
  http://<mac-mini>:8788/worker/status
curl -fsS -X POST -H "Authorization: Bearer $WELES_API_TOKEN" \
  http://<mac-mini>:8788/worker/start
curl -fsS -X POST -H "Authorization: Bearer $WELES_API_TOKEN" \
  http://<mac-mini>:8788/worker/restart
```

`start` is idempotent. `restart` always uses `launchctl kickstart -k` when the
agent is loaded. Both operations wait up to five seconds for a running process
and return the observed pre/post state; concurrent lifecycle mutations return
HTTP 409. No endpoint accepts a command, label, plist path, or shell fragment.


## Operate

```bash
sudo systemctl status weles-worker
tail -f ~/weles/var/worker.log
sudo systemctl restart weles-worker   # after git pull + npm run build
```

## Drain state

```bash
psql "$DATABASE_URL" -c "
  SELECT status, COUNT(*) FROM account_action_logs
  WHERE started_at > NOW() - INTERVAL '1 hour'
  GROUP BY status ORDER BY 1;"
```

Worker claims the oldest `queued` rows first (ordered by `scheduled_at`). If
the queue has older stale rows, they drain before new campaign items — flush
with a `UPDATE ... SET status='cancelled'` if needed.

## Skarbiec vault bridge

Platform login material comes from an encrypted Skarbiec vault. Skarbiec is the
source of truth; Weles neither vendors its source nor publishes its binaries or
vaults.

The host operator provisions the Skarbiec binary, encrypted vault, optional
public recipient-key bundle, and owner private key through Skarbiec's own
installation and recovery process. Configure only their absolute local paths:

```bash
SKARBIEC_BIN=/usr/local/bin/skarbiec-entitlements-router
SKARBIEC_VAULT_FILE=/Users/<user>/.local/share/skarbiec/skarbiec.vault.json
SKARBIEC_RECIPIENT_KEYS=/Users/<user>/.local/share/skarbiec/skarbiec-recipients.asc
```

`launch-mac.sh` refuses to start without an executable `SKARBIEC_BIN` and a
present vault. It imports optional public recipient keys, unlocks the vault
through the login keychain or `SKARBIEC_UNLOCK`, and exposes an owner-only
runtime view through `WELES_SERVICE_CREDENTIALS_FILE`. Credential return invokes
Skarbiec's own `sync-push`; Weles does not upload Skarbiec release assets.
