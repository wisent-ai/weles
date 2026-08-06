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

## Immutable artifacts

The operator must publish all of these exact artifacts for the selected
`<version>` and `<platform>` coordinates:

```text
stado://releases/weles-worker/<version>/<platform>/weles-worker.tar.gz
stado://releases/weles-chromium/<version>/<platform>/weles-chromium.tar.gz
stado://releases/weles-firefox/<version>/<platform>/weles-firefox.tar.gz
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

## Install the launch wrapper + unit

```bash
sudo install -m 0755 ~/weles/scripts/worker/deploy/launch.sh /usr/local/bin/weles-worker-launch
sudo cp ~/weles/scripts/worker/deploy/systemd.service /etc/systemd/system/weles-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now weles-worker
```

## macOS worker + auto-deploy

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
`skarbiec.credential-operation.v3` contract to the hosted task endpoint and
polls the returned action-log ID without returning task payloads. The bridge
resolves that endpoint from the Stado forward file
`${STADO_FORWARDS_DIR:-$HOME/.stado/forwards}/weles-admission.local`, which must
be an owner-only regular file holding exactly one URL; `WELES_URL` is no longer
read and an unresolved endpoint fails closed as `needs_configuration` with code
`WELES_ENDPOINT_UNRESOLVED`.

Configure Skarbiec with the absolute installed bridge path through
`SKARBIEC_WELES_CREDENTIAL_COMMAND`. `credential acquire`, `adopt`, `rotate`,
`reset`, and `verify` carry only bounded identifiers, account binding, purpose,
and the canonical `directory` block (`provider`, `tenant_id`,
`principal_object_id`, `account_upn`); password material never crosses the
bridge. Unknown item/provider/operation combinations fail closed.

Microsoft Entra work accounts use their own provider `microsoft_entra`, origin
`https://login.microsoftonline.com`, actions `microsoft_entra_adopt_password`,
`microsoft_entra_reset_password` and `microsoft_entra_verify_password`, and the
exact items `weles-microsoft-jakub-wisent-ai-password` and
`weles-microsoft-lukasz-wisent-com-password`. `adopt` takes over a password the
operator already knows: Skarbiec stages that candidate under the item, Weles
proves it with a fresh login plus the full identity assertion and writes nothing,
and Skarbiec activates the staged revision on success. `rotate` requires the
known managed password so a compensating rollback stays possible; `reset` is the
separate operation for an unknown current password. Consumer Microsoft accounts
keep provider `microsoft` and origin `https://account.live.com`.

The directory identity is the item's own write-once contract, never a call
argument. The lifecycle request carries no flat `account_upn`, `tenant_id`, or
`principal_object_id`: Skarbiec reads them from the item and sends the whole
`directory` block, the trajectory takes the identity from exactly that block, and
a missing or partial block is a refusal instead of a default.

Every terminal answer states one three-valued `provider_effect`: `none` when the
directory password was left untouched, `changed` when the directory accepted a
new value, and `unknown` when the run cannot prove which value the directory now
holds. Only `none` may be retried automatically; `changed` needs an explicit
`verify` or a confirmed rollback first, and `unknown` quarantines the item. The
former `provider_password_changed` flag is gone.

`needs_human_approval` carries an `approval` resource with `approval_id`,
`phase`, `provider_effect`, `expires_at` (a bounded four-hour lease),
`resume_token`, and `instruction`. All six fields travel together or the object
is dropped; resubmitting is not a resume path, and an expired lease releases the
operation instead of leaving a zombie.

`operation_completed` carries a `receipt` with `tenant_id`,
`principal_object_id`, `account_upn`, `operation`, `request_id`,
`evidence_digest` (SHA-256 over the canonical session evidence of that run),
`execution_host`, `changed_at` (null when nothing changed), `verified_at`, and
`action_log_id`, so `credential status` answers whether exactly this principal
was rotated without reading a mailbox or a log. No password and no value derived
from one is ever part of it, and a receipt naming another identity, request, or
operation is rejected as a protocol violation.

Snap Kit production API-token acquisition uses item
`weles-snapchat-snap-kit-api`, field `api_token`, writer consumer
`weles-snapchat-snap-kit-api-writer`, and owner-only token file
`~/.stado/weles-snapchat-snap-kit-api-writer-skarbiec-token`. Provision that
consumer with only `write:weles-snapchat-snap-kit-api`; the bridge cannot
substitute another item or provider.
