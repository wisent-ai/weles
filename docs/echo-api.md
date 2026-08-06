# Echo API boundary

Weles owns the database, worker state, account action log, lifecycle state, campaign-item state, and acquired-secret lifecycle. Echo accesses those capabilities only through the authenticated API implemented by `src/api/echo-server.ts`.

## Transport and authentication

The server binds to loopback only and requires `Authorization: Bearer <token>` on every request. The Echo client accepts HTTPS origins, or HTTP only when the URL host is loopback. A remote deployment must publish the loopback listener through an HTTPS reverse proxy; the Node listener must not be rebound to a public HTTP interface.

The dedicated token contract is:

- Skarbiec item: `echo-weles-api`
- Field: `token`
- Weles bootstrap consumer: `weles-echo-api-token-bootstrap`
- Weles bootstrap file: `~/.stado/weles-echo-api-token-bootstrap-skarbiec-bootstrap-token`
- Weles runtime variable: `WELES_ECHO_API_TOKEN`
- Echo consumer: `echo-weles-api-client`
- Echo token file: `~/.stado/echo-weles-api-client-skarbiec-token`
- Echo runtime variable: `ECHO_WELES_API_TOKEN`
- Echo nonsecret endpoint variable: `ECHO_WELES_API_URL`

The token must be distinct from database, object, model-router, media-router, artifact-delivery, operator-CDP, and other product tokens. The Weles launcher bootstrap has only the exact `echo-weles-api#token` acquisition scope and no direct read scope; the Echo client grant remains independently owned. Do not put either token in a repository env file.

The production origin is `https://charless-mac-mini.tail6443b3.ts.net`. The
`lbartoszcze.github` tailnet publishes HTTPS through Tailscale Funnel and
proxies it to `http://127.0.0.1:8794`; the loopback listener remains the sole
application listener. `ECHO_WELES_API_URL` stores only that public origin.

## Launcher

`scripts/worker/deploy/launch-echo-api-mac.sh` acquires the two Weles database fields and the dedicated Echo API token through separate one-field bootstrap consumers, loads the finite action catalog, clears inherited Supabase service-role variables, and starts `dist/api/echo-server.js`. `WELES_ECHO_API_PORT` is optional; the listener remains on loopback regardless of configuration.

## Finite operation surface

All operations are JSON POST requests under `/v1/echo/`. The allowlist covers account action-log reads, account gate reads, enqueue and status operations, Pangram jobs, action-result recording, worker state, deployment version, lifecycle runs and events, Weles-owned secret acquisition, health/login producers, and campaign scheduling. There is no SQL endpoint, table-name parameter, script-path parameter, command execution, environment forwarding, or generic database mutation operation.

Job actions are additionally checked against the deployed `weles-action-allowlist.txt`. Request objects reject command, executable, working-directory, script, and environment keys. Secret acquisition invokes Weles' own registry and Skarbiec lifecycle; Echo never receives Weles database authority.
