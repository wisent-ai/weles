# Slack trajectory invariants

## Workspace

- The Wisent Slack workspace is at **`https://wisent-workspace.slack.com`** (verified by HTTP 200 GET; the candidate alternatives `wisentai.slack.com`, `getwisent-workspace.slack.com`, `wisent-ai.slack.com` all return 404).
- The org uses **Google Workspace SSO**. Sign-in path: workspace URL → "Sign in with Google" → Google OAuth consent → back to Slack web.

## Credentials

- Sourced from **`weles/.work/_sso.env`** at runtime: `SSO_EMAIL`, `SSO_PASS`. Do NOT bake values into the trajectory or log them — only `process.env.SSO_EMAIL` / `process.env.SSO_PASS` after `set -a; . _sso.env; set +a`.
- There is **no `slack` row in `social_accounts`** and no `xoxb`/`xoxe`/webhook stored anywhere (verified: searched every `.env` in every Wisent repo, the Mac Keychain, Supabase `service_credentials` + `oauth_credentials`, Vercel project env — all empty). The trajectory MUST mint a fresh bot token via the api.slack.com app-creation flow.

## App manifest

- 12-scope bot manifest matching `oko/scripts/slack-bootstrap.sh` (M58/M59): `chat:write, chat:write.public, channels:read, channels:history, groups:read, groups:history, im:history, mpim:history, users:read, users:read.email, reactions:read, reactions:write`.
- App name: `Claude Code`. Display name: `Claude Code`.

## Posting

- Target message: `oko/.work/jakub-status.txt` (pre-rendered M59 status update).
- Target user: `@3Qax` (Jakub Towarek, `kuba@towarek.pl`, Oko collaborator).
- Posting mechanism: `oko-cli slack post --channel <C…> --text-file <PATH>` from the Oko repo. The trajectory does NOT post directly — it captures the token, injects it via env, then shells out to `oko-cli`. Avoids reimplementing chat.postMessage HTTP in the trajectory.

## Channel resolution

- Default channel name: `jakub` (override via `SLACK_TARGET_CHANNEL` or `SLACK_TARGET_CHANNEL_NAME` env).
- If the named channel is not found, try `general` next.

## DOM selectors (record changes here when Slack ships a redesign)

- App manifest YAML textarea: `textarea[aria-label*="manifest"]` or `.ace_text-input` (Ace editor).
- "From a manifest" button: button containing the text `From a manifest`.
- "Install to Workspace" button: button containing `Install to Workspace`.
- "Allow" button on consent: button containing `Allow` after the consent page loads.
- OAuth & Permissions sidebar nav: `a[href*="/oauth"]`.
- Bot User OAuth Token row: button labeled `Copy` next to the token field containing `xoxb-`.
