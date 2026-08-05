# Weles worker — VM deployment

Runs `node scripts/worker/run.mjs` as a systemd service. Drains
`account_action_logs` rows that the Echo campaign scheduler and lifecycle
simulation crons enqueue.

## Host prerequisites

- A supported host platform and the runtime prerequisites already included in
  the published worker archive contract.
- HTTPS access to the Stado release API.
- An operator-owned deployment env at `~/.config/weles/worker.env`.
- `~/weles` prepared as a symlink target; auto-deploy refuses to replace a
  mutable checkout or directory.


## Canonical release and rollback runbook

Production is manifest-driven. Component repositories publish immutable worker,
Chromium, Firefox, web, client, and desktop artifacts through their own release
channels; none of those releases independently changes the running worker.

1. Pause legacy queue producers, wait for every in-flight legacy job to finish, and
   capture the current baseline before the first cutover. Include executable rollback
   bytes, not only a descriptive hash:

   ```bash
   node scripts/release/capture-baseline.mjs \
     --out ~/.local/state/weles-release/legacy-baseline.json \
     --archive-out ~/.local/state/weles-release/legacy-baseline.tar.gz
   ```
   Only the first production `activate.mjs` invocation additionally requires
   `--legacy-drained true`; candidate, development, and canary workers never
   claim queue rows.

2. Normalize each approved component release into the fragment shape required by
   `release/deployment-manifest.schema.json`. Assemble one manifest:

   ```bash
   node scripts/release/assemble-manifest.mjs \
     --deployment-id 2026-08-04.1 \
     --created-at 2026-08-04T12:00:00Z \
     --source-revision <weles-full-sha> \
     --worker worker.json --web web.json --database database.json \
     --client client.json --chromium chromium.json --firefox firefox.json \
     --compatibility compatibility.json --output deployment.json
   ```

3. Publish the exact manifest as a prerelease candidate:

   ```bash
   node scripts/release/publish-manifest.mjs --manifest deployment.json
   ```

   Publication fails before creating a GitHub Release unless tracked release
   inputs match `HEAD` and the authenticated `gh` actor appears in the
   repository's `WELES_RELEASE_APPROVERS` variable.

   The release workflow validates its source-bound identity and uploads a portable
   Sigstore bundle beside the manifest. After that attestation succeeds, install
   the asset by exact URL and SHA-256 with `scripts/release/install.mjs`; installation
   verifies the downloaded bundle even though the repositories remain private.
4. Stage the Weles product manifest and release journeys in Probierz, then run
   the exact candidate bytes and endpoints:

   ```bash
   node scripts/release/prepare-probierz.mjs --probierz-root ../probierz
   cd ../probierz
   PROBIERZ_BUILD_PATH=/absolute/path/to/deployment.json \
   BASE_URL=https://candidate.weles.example \
   WELES_WORKER_URL=https://candidate-worker.weles.example \
   WELES_WORKER_API_TOKEN='<candidate token>' \
   node agent/cli.mjs run web --app weles --spec weles-release.spec.mjs --record
   node agent/cli.mjs source-identity weles
   node agent/cli.mjs receipt weles 2026-08-04.1 <harness-sha256> \
     --source-sha <app-source-sha256> --runs <comma-separated-run-ids> \
     > /secure/path/weles-evidence-receipt.json
   ```

   The release receipt must be signed by Probierz and cover `web-contract`,
   `worker-contract`, `chromium-candidate`, and `firefox-candidate` at E3.
5. Activate the installed manifest in strict order: `candidate`,
   `development`, `canary`, then `production`. Every activation re-verifies the
   signed Probierz receipt, exact run IDs, clean Weles source revision, and
   manifest build digest. The same manifest SHA-256 must advance through every
   ring:

   ```bash
   node scripts/release/activate.mjs \
     --manifest-sha256 <sha256> --host <stado-host> --ring candidate \
     --probierz-root ../probierz \
     --evidence-receipt /secure/path/weles-evidence-receipt.json \
     --run-ids <comma-separated-run-ids> \
     --public-key /secure/path/probierz-receipt-signing-key.pub.pem
   ```

   Repeat with `development` and `canary`. For the first production cutover,
   use the baseline-verifying migration command instead of writing the mode file
   by hand:
+
   ```bash
   node scripts/release/cutover-legacy.mjs \
     --baseline ~/.local/state/weles-release/legacy-baseline.json \
     --manifest-sha256 <sha256> --host <production-stado-host> \
     --probierz-root ../probierz \
     --evidence-receipt /secure/path/weles-evidence-receipt.json \
     --run-ids <comma-separated-run-ids> \
     --public-key /secure/path/probierz-receipt-signing-key.pub.pem \
     --confirm 'LEGACY TO IMMUTABLE'
   ```
+
   The command re-hashes the retained rollback archive, atomically disables
   legacy branch polling, and restores the previous deployment mode if
   production activation fails. Use `--check-only true` to validate the plan
   without changing the host.
6. Inspect one persistent ring/host state:

   ```bash
   node scripts/release/status.mjs --ring canary --host <stado-host>
   ```

   The active runtime reports worker, browser, database, API-schema, manifest,
   claim mode, and lease-generation identity. Non-production heartbeats use
   per-instance keys and cannot overwrite the canonical production heartbeat.
7. Roll back one ring to its retained previous manifest:

   ```bash
   node scripts/release/rollback.mjs --ring production --host <stado-host>
   ```

   Rollback reactivates the exact retained wrapper through Stado and records a
   `rolled_back` receipt. It does not loosen promotion ordering for new
   manifests.

The production database lease rejects queued-to-running claims from any
deployment other than the active production generation. Non-production
workers are additionally built with queue claiming disabled. During production
activation the old worker drains, the lease advances, Stado replaces the unit,
and a fresh per-activation instance must report the exact manifest heartbeat
before success is recorded. Activation restores the prior lease and unit if
any later step fails.

`scripts/worker/deploy/auto-deploy.sh` and its LaunchAgent are an emergency
legacy baseline only. `cutover-legacy.mjs` writes
`~/.config/weles/deployment-mode` as `immutable-manifest`; the mode file
overrides LaunchAgent environment and prevents branch polling from returning.

## Immutable worker component release

Production worker bytes are published only by this repository under
`worker-vX.Y.Z` GitHub Releases. The tag must equal `worker-v` plus the
`package.json` version. Each release contains
`weles-worker-X.Y.Z.tar.gz`, its SHA-256 sidecar, and embedded provenance.
The release workflow accepts the tag only when its pushing actor appears in the
comma-separated `WELES_RELEASE_APPROVERS` repository variable. A missing or
empty allowlist fails before dependency installation and artifact construction.

Do not unpack this component into a live path or run a package manager after
release. Record the release URL, archive SHA-256, entrypoint, provenance URL,
and source repository in the worker fragment; the manifest install agent
downloads and verifies the exact archive.

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

The worker archive is a deployable runtime, not a source checkout: it must
contain the built `dist/` tree, runtime `node_modules/`,
`scripts/worker/run.mjs`, the tracked launchers and LaunchAgents, and both
browser installers. Auto-deploy does not clone, fetch, pull, run a package
manager, build source, inspect a tag/channel, or use provider credentials.
Each archive has an independently configured SHA-256. See
`release.env.example` for the required variable names; values stay in the
operator-owned env file.

## Credentials

The worker launcher accepts no database service-role, provider API key, or
platform password from `worker.env`. The file contains nonsecret runtime
settings and release coordinates only.

All credential reads use workload-bound Skarbiec acquisitions. The worker keeps
one owner-only Ed25519 private signing key and a nonsecret stable workload id.
Each exact consumer/item/field identity is registered in Skarbiec with the
matching public key and no standing bearer. The client signs a fresh timestamp
and nonce for `POST /v1/acquisitions`, then uses the returned short-TTL bearer
once at `POST /v1/acquisitions/read`. The single field is mapped directly to the
requesting process and is never written to a file. Proof replay, expiry, or a
different workload, consumer, item, or field is unauthorized.

`skarbiec-acquisition-scopes.conf` is the nonsecret launcher and runtime
contract. Its grammar is one `consumer|item|field` row per scope. Components
must match exact `[A-Za-z\d._-]+` names; blank components, wildcards, globs,
lists, and duplicate rows fail before a proof is signed.

| Process variable | Acquisition consumer | Item | Field |
| --- | --- | --- | --- |
| `WELES_DATABASE_URL` | `weles-database-url-bootstrap` | `weles-database` | `url` |
| `WELES_DATABASE_TOKEN` | `weles-database-service-role-bootstrap` | `weles-database` | `service_role_key` |
| `WELES_STADO_OBJECT_API_TOKEN` | `weles-object-token-bootstrap` | `weles-object-api` | `token` |
| `WELES_STADO_MODEL_ROUTER_TOKEN` | `weles-model-router-token-bootstrap` | `weles-model-router` | `token` |
| `WELES_STADO_MODEL_ROUTER_AGENT_ID` | `weles-model-agent-id-bootstrap` | `weles-model-agent-auth` | `id` |
| `WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET` | `weles-model-agent-secret-bootstrap` | `weles-model-agent-auth` | `agent_auth_secret` |
| `WELES_ARTIFACT_DELIVERY_TOKEN` | `weles-artifact-delivery-token-bootstrap` | `weles-artifact-delivery` | `token` |
| `WELES_ARTIFACT_SIGNING_SECRET` | `weles-artifact-signing-secret-bootstrap` | `weles-artifact-signing` | `signing_secret` |
| `OKO_WELES_SUBSCRIPTIONS_TOKEN` | `weles-subscriptions-token-bootstrap` | `oko-weles-subscriptions` | `token` |
| `CONTENT_DIAGNOSTICS_API_TOKEN` | `weles-content-diagnostics-token-bootstrap` | `weles-content-diagnostics` | `token` |
| `TRADING_TOOLS_INGEST_TOKEN` | `weles-trading-ingest-token-bootstrap` | `weles-trading-tools-ingest` | `token` |
| `TRADING_TOOLS_INGEST_HMAC_SECRET` | `weles-trading-ingest-hmac-bootstrap` | `weles-trading-tools-ingest` | `hmac_secret` |
| `WELES_OPERATOR_CDP_URL` | `weles-operator-cdp-url-bootstrap` | `weles-operator-cdp` | `url` |
| `WELES_OPERATOR_CDP_TOKEN` | `weles-operator-cdp-token-bootstrap` | `weles-operator-cdp` | `token` |
| `WELES_ECHO_API_TOKEN` | `weles-echo-api-token-bootstrap` | `echo-weles-api` | `token` |
| Keyword-planner `WELES_STADO_MODEL_ROUTER_TOKEN` | `weles-keyword-planner-router-bootstrap` | `weles-keyword-planner-model-router` | `token` |

Generate the workload identity once on the Weles host:

```bash
umask 077
openssl genpkey -algorithm Ed25519 \
  -out "$HOME/.stado/weles-workload-signing-key.pem"
openssl pkey -in "$HOME/.stado/weles-workload-signing-key.pem" -pubout \
  -out "$HOME/.stado/weles-workload-signing-key.pub.pem"
```

Set `SKARBIEC_WORKLOAD_ID` to the stable deployment identity and
`SKARBIEC_WORKLOAD_SIGNING_KEY_FILE` to the absolute private-key path in
`worker.env`. Copy only the public key to the Skarbiec operator, then register
the complete tracked catalog atomically:

```bash
skarbiec token-register-acquisitions \
  /absolute/path/to/skarbiec-acquisition-scopes.conf \
  --workload-public-key-file /secure/inbox/weles-workload-signing-key.pub.pem
```

The registration response contains no bearer. Existing action-time platform,
proxy, captcha, SMS, and business-SaaS reads use the same proof path lazily in
the owning action. Writer-only flows retain separate exact
`stage:<item>#<field>` bearer capabilities; acquisition never authorizes mutation.

The model identity item must contain exact `id=weles`. `callJeden` maps its
startup fields only in the child environment to `STADO_MODEL_ROUTER_TOKEN`,
`WISENT_APP_AGENT_ID`, and `WISENT_APP_AGENT_AUTH_SECRET`. Ambient provider keys
and ambient child credential names are not inherited. The only accepted Weles
agent alias is `weles/agent/primary`.

Apple password login is disabled unless an operator first issues a one-attempt
authorization with `scripts/auth/authorize-apple-login.mjs`. The worker needs
an absolute, owner-owned executable bridge:

```bash
APPLE_2FA_RELAY_COMMAND=/home/<user>/weles/scripts/auth/request-apple-challenge-relay.mjs
APPLE_2FA_MAC_HOST=<trusted-mac-host>
APPLE_2FA_MAC_USER=<ssh-user>
APPLE_2FA_MAC_PORT=22
APPLE_2FA_MAC_IDENTITY_FILE=/home/<user>/.ssh/apple-2fa
APPLE_2FA_MAC_KNOWN_HOSTS_FILE=/home/<user>/.ssh/apple-2fa-known-hosts
APPLE_2FA_MAC_RELAY_COMMAND=/Users/<user>/weles/scripts/auth/relay-apple-challenge.mjs
```

The fixed command on the trusted Mac requires its own pinned SSH configuration
for Skarbiec (`APPLE_2FA_SKARBIEC_HOST`, `APPLE_2FA_SKARBIEC_USER`,
`APPLE_2FA_SKARBIEC_PORT`, `APPLE_2FA_SKARBIEC_IDENTITY_FILE`,
`APPLE_2FA_SKARBIEC_KNOWN_HOSTS_FILE`, and
`APPLE_2FA_SKARBIEC_COMMAND`). The Mac-to-Skarbiec SSH key must be a forced,
write-only command restricted to `apple-challenge-put`; it must not expose any
vault read or general CLI surface. The bridge captures the native trusted-device
prompt, stores the six-digit code directly under the authorization-bound
challenge resource, and returns only an acknowledgement. Private keys and env
files must be mode `0600`; bridge scripts must be owner-owned, executable, and
not group/world writable.

Authorize exactly one queued login from an authorized host:

```bash
node scripts/auth/authorize-apple-login.mjs \
  --account-id <uuid> --approver <operator> --reason '<ticket/reason>' \
  --execution-host <exact-worker-hostname> --execution-agent <skarbiec-agent> \
  --ssh-host <skarbiec-host> --ssh-user <ssh-user> --ssh-port 22 \
  --ssh-identity-file <absolute-path> --ssh-known-hosts-file <absolute-path> \
  --remote-skarbiec-command <absolute-path> \
  --confirm 'AUTHORIZE ONE APPLE LOGIN'
```

Any post-submit uncertainty leaves the account in `failed_open`; it is not
eligible for another authorization. Call `resolve_apple_auth_failed_open` only
after independently confirming the browser is closed, the Apple challenge is
gone, and all three capabilities are inactive. Resolution deletes the private
capability envelope and unlocks the account.

## Worker environment

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

## Legacy macOS worker and auto-deploy baseline

The Mac worker uses `~/.config/weles/worker.env` as its operator-controlled
deployment contract. `auto-deploy.sh` fetches the exact configured
`weles-worker.tar.gz` through `/api/release/object`, verifies its configured
SHA-256, checks the required runtime layout, and stages it under
`~/.local/share/weles-worker/<version>/<platform>/`.

Before changing the active symlink or restarting any LaunchAgent, auto-deploy
runs both browser installers. They independently require their selected Stado
objects and checksums. A missing or mismatched worker or browser artifact leaves
the currently active release untouched and aborts the deployment.

After every artifact is verified, `~/weles` is atomically repointed to the exact
worker release. The tracked worker, keyword-planner, and Echo LaunchAgents are
then copied from that immutable release and restarted. No GitHub CLI, Git
credential helper, ambient provider token, source checkout, package install, or
host-side build participates in deployment.

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
The auto-deploy LaunchAgent itself is the stable bootstrap. Initial provisioning
must install it from an operator-reviewed release, create `~/weles` as a symlink,
and populate `~/.config/weles/worker.env` with exact coordinates. The repository
does not provide or guess those values.


## Operate

```bash
tail -f ~/.local/state/weles/auto-deploy.log
```

To deploy, change all selected release coordinates and digests in the
operator-owned env file. The next poll either activates that complete immutable
set or fails closed without switching the current release.

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

## Skarbiec boundary

Platform, proxy, captcha, SMS, and business-SaaS credentials are resolved only
through the finite Weles service catalog. Each read uses its own exact
consumer/item/field workload identity and the shared deployment signing key;
there is no read bearer file. Writer-only flows use separate owner-controlled
tokens carrying exact `stage:<item>#<field>` capabilities. Launchers never
decrypt a broad credential view or provide a global bearer.

Hosted public-client tasks are tenant-bound. For an organization UUID, create an
owner-only directory under
`~/.stado/weles-skarbiec-tenants/<organization-uuid>/` containing:

```text
skarbiec-url
weles-semantic-scholar-api-writer-skarbiec-token
weles-github-admin-org-token-writer-skarbiec-token
weles-supabase-personal-access-token-writer-skarbiec-token
weles-snapchat-snap-kit-api-writer-skarbiec-token
```

`skarbiec-url` contains only the customer's exact HTTPS Skarbiec endpoint.
Install only the token files for acquisition contracts that customer enabled.
The directory, endpoint file, and token files must be regular, owned by the
worker account, and inaccessible to group and other users:

```sh
tenant=<organization-uuid>
binding="$HOME/.stado/weles-skarbiec-tenants/$tenant"
mkdir -p "$binding"
chmod go-rwx "$binding"
printf '%s\n' 'https://skarbiec.customer.example' > "$binding/skarbiec-url"
chmod go-rwx "$binding/skarbiec-url" "$binding"/*-skarbiec-token
```

`WELES_SKARBIEC_TENANTS_DIR` may override the binding root with an absolute
path. A task carrying `tenant_id` never falls back to the deployment-wide
`WELES_SKARBIEC_URL` or deployment-wide writer token files. The tenant UUID on
the Weles API key, queued task, worker constraints, endpoint directory, mailbox
follow-up, and Skarbiec write must match end to end.

The public bridge distributed from
[`wisent-ai/weles-client`](https://github.com/wisent-ai/weles-client) is the
only supported Skarbiec lifecycle bridge. It submits the strict
`skarbiec.credential-operation.v1` contract to the hosted task endpoint and
polls the returned action-log ID without returning task payloads.

Configure Skarbiec with the absolute installed bridge path through
`SKARBIEC_WELES_CREDENTIAL_COMMAND`. `credential acquire`, `rotate`, and
`verify` carry only bounded identifiers, account binding, and purpose; password
material never crosses the bridge. Unknown item/provider/operation combinations
fail closed.

Snap Kit production API-token acquisition uses item
`weles-snapchat-snap-kit-api`, field `api_token`, writer consumer
`weles-snapchat-snap-kit-api-writer`, and owner-only token file
`~/.stado/weles-snapchat-snap-kit-api-writer-skarbiec-token`. Provision that
consumer with only `write:weles-snapchat-snap-kit-api`; the bridge cannot
substitute another item or provider.
