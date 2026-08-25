# Admission API boundary

Weles owns the database, worker state, account action log, lifecycle state, campaign-item state, and acquired-secret lifecycle. Echo accesses those capabilities only through the admission API implemented by `src/api/admission-server.ts`.

## Transport and admission

The server binds to loopback only. On a loopback bind `WELES_ADMISSION_TOKEN` is
optional: without it every request is served unauthenticated and the startup line
reads `listening on unauthenticated loopback`. With it every request must carry
`Authorization: Bearer <token>`, the token must be at least 32 bytes, must differ
from the Weles database token, and is compared as a constant-time SHA-256 digest.
A bind to any host outside `127.0.0.1`, `::1`, and `localhost` refuses to start
without the token.

The Echo client accepts HTTPS origins, or HTTP only when the URL host is loopback. A remote deployment must publish the loopback listener through an HTTPS reverse proxy; the Node listener must not be rebound to a public HTTP interface. Publishing the listener past the host removes the loopback assumption, so set `WELES_ADMISSION_TOKEN` whenever the origin is reachable from outside the machine.

The production origin is `https://charless-mac-mini.tail6443b3.ts.net`. The
`lbartoszcze.github` tailnet publishes HTTPS through Tailscale Funnel and
proxies it to `http://127.0.0.1:8794`; the loopback listener remains the sole
application listener. `ECHO_WELES_API_URL` stores only that public origin.

The Skarbiec item `echo-weles-api` still exists and is untouched, but Weles no
longer acquires or requires it: no Weles bootstrap consumer reads it and no Weles
runtime variable carries it.

## Launcher

`scripts/worker/deploy/launch-admission-api-mac.sh` acquires the two Weles database fields through separate one-field bootstrap consumers, loads the finite action catalog, clears inherited Supabase service-role variables, and starts `dist/api/admission-server.js`. `WELES_ADMISSION_PORT` is optional; the listener remains on loopback regardless of configuration.

## Finite operation surface

All operations are JSON POST requests under `/v1/echo/`. The allowlist covers account action-log reads, account gate reads, enqueue and status operations, Pangram jobs, action-result recording, worker state, deployment version, lifecycle runs and events, Weles-owned secret acquisition, health/login producers, and campaign scheduling. There is no SQL endpoint, table-name parameter, script-path parameter, command execution, environment forwarding, or generic database mutation operation.

Job actions are additionally checked against the deployed `weles-action-allowlist.txt`. Request objects reject command, executable, working-directory, script, and environment keys. Secret acquisition invokes Weles' own registry and Skarbiec lifecycle; Echo never receives Weles database authority.
