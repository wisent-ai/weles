# Slack trajectory invariants

## Workspace

- The Wisent Slack workspace is at **`https://wisent-workspace.slack.com`** (verified by HTTP 200 GET; the candidate alternatives `wisentai.slack.com`, `getwisent-workspace.slack.com`, `wisent-ai.slack.com` all return 404).
- The org uses **Google Workspace SSO**. Sign-in path: workspace URL → "Sign in with Google" → Google OAuth consent → back to Slack web.

## Credentials

- Default path is the existing Oko bot token: `SLACK_BOT_TOKEN` env, then `~/.oko/bot-token`, then `~/.oko/slack.json` (`bot_token`, `botToken`, or `SLACK_BOT_TOKEN`). Do NOT log token values.
- Do **not** create a new Slack app when a bot token exists. Re-creating the app produces duplicate/wrong Slack identities.
- Google Workspace SSO credentials from **`weles/.work/_sso.env`** (`SSO_EMAIL`, `SSO_PASS`) are fallback-only for the browser app-creation path when no bot token is configured.
## App manifest

- 12-scope bot manifest matching `oko/scripts/slack-bootstrap.sh` (M58/M59): `chat:write, chat:write.public, channels:read, channels:history, groups:read, groups:history, im:history, mpim:history, users:read, users:read.email, reactions:read, reactions:write`.
- App name: `Claude Code`. Display name: `Claude Code`.

## Posting

- Target message defaults to `oko/.work/jakub-status.txt`, but `MESSAGE_TEXT` takes precedence and is the preferred queue-safe input because it survives cross-host enqueue.
- Fast path posts directly with `chat.postMessage` using the stored bot token. The trajectory resolves the target from `SLACK_TARGET_CHANNEL`, `SLACK_TARGET_CHANNEL_NAME`, `SLACK_TARGET_USER_ID`, or recipient matchers.
- Browser/SSO app creation is only a last-resort fallback when no stored bot token is available.

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
