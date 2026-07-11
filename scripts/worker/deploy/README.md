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

## Clone + build

```bash
git clone https://<token>@github.com/wisent-ai/weles.git ~/weles
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
WELES_STADO_ROUTING=required
STADO_REGISTRY_URI=gs://wisent-compute/registry.json
EOF
chmod 600 ~/weles/var/worker.env
```

## Stado placement policy

Production workers fail closed unless their normalized OS hostname resolves to
exactly one `kind: "local"` target in the canonical Stado registry. Placement
configuration is non-secret and belongs in `gs://wisent-compute/registry.json`:

```json
{
  "schema_version": 2,
  "targets": [{
    "name": "browser-worker-1",
    "kind": "local",
    "hostnames": ["browser-worker-1.local"],
    "weles": { "enabled": true, "actions": ["generic_browser_task"] }
  }]
}
```

Use `actions: ["*"]` for all dispatchable actions. Exact action lists partition
work; overlaps intentionally load-share through the existing conditional
`queued` to `running` claim. Set `enabled: false` to drain new claims. Missing,
invalid, ambiguous, expired, or unreachable policy denies claims. Registry
changes propagate within 30 seconds. Keep Supabase and browser credentials only
in the host-local `worker.env`; never put secrets in Stado.

Validate before publishing:

```bash
wc registry validate registry.json
wc registry push registry.json
```

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

## skarbiec vault bridge

Platform login material comes from an encrypted skarbiec vault — skarbiec is the
source of truth, and no plaintext copy is consulted at runtime. The skarbiec
source is vendored at `vendor/skarbiec`; a CI workflow builds the arm64 binary
and publishes it, with a `sha256` sidecar, to the rolling release
`skarbiec-bin-latest`. The encrypted vault ciphertext is published to the
release `skarbiec-vault-latest` (gpg, encrypted to the owner and recovery keys;
the release alone cannot decrypt it). On each launch `launch-mac.sh` downloads
the binary and the vault with the worker's existing weles access, imports the
owner private half from `~/.weles-secrets/skarbiec-owner.asc` when the keyring
lacks it, decrypts the real vault with the unlock value (a login-keychain item
or `SKARBIEC_UNLOCK` from the worker configuration), and points
`WELES_SERVICE_CREDENTIALS_FILE` at an owner-only view.

Provisioning happens once, out-of-band, at the same tier as the gcloud
service-account material and the worker configuration. The passphrase-protected
owner private half is placed at `~/.weles-secrets/skarbiec-owner.asc`. The
unlock value is provided as `SKARBIEC_UNLOCK` in `~/weles/var/worker.env`. When
the vault changes, re-publish its ciphertext to `skarbiec-vault-latest`.
