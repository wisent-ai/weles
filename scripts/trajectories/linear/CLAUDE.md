# Linear trajectory invariants

## Workspace

- Linear web app: `https://linear.app`
- Workspace login URL: `https://linear.app/login`
- After login, the Wisent workspace lives at `https://linear.app/<workspace-slug>/`. The slug is whatever the org set up (e.g. `wisent`). The trajectory does NOT pin the slug — it follows whatever URL Linear lands on after SSO.
- Authentication: **Google Workspace SSO** (same path as the Slack trajectory, since the Wisent org uses Google Workspace).

## Credentials

- Sourced from `service_credentials` row `display_name='Linear'` (`login_email`, `login_password`). If absent, the SSO falls back to `weles/.work/_sso.env` `SSO_EMAIL` / `SSO_PASS` exactly like the slack trajectory.
- Personal API keys minted by `get_api_key.mjs` are persisted to:
  - `~/.linear/token` (chmod 600) — the file the Oko `wip-summarize.mjs` reads.
  - `service_credentials` row `display_name='Linear'`, `api_key_env_var='LINEAR_API_KEY'` (env-var binding only; the actual key value still lives in `~/.linear/token` and is loaded into `LINEAR_API_KEY` at runtime by the caller).

## API

- GraphQL endpoint: `https://api.linear.app/graphql` (POST, JSON body, query field).
- Auth header: `Authorization: <api_key>` (the raw `lin_api_…` key — **no `Bearer ` prefix**; that's for OAuth tokens, not personal API keys).
- Personal API key format: `lin_api_` + alphanumeric.
- Rate limit: ~1500 requests/hour for personal API keys (more than enough for WIP summarizer use).

## DOM selectors (record changes here when Linear ships a redesign)

- Google SSO button on login page: `button:has-text("Continue with Google")` or `a:has-text("Continue with Google")`.
- Workspace landing detector: URL matches `linear\.app/[^/]+/(team|my|issues|inbox)` after SSO.
- Settings entrypoint: avatar in lower-left → `Settings` menu item, OR direct URL `linear.app/settings/account/security` for the API tab.
- API tab: `linear.app/settings/api` (also reachable via Settings → API in the sidebar).
- "Create new" button on the API page: `button:has-text("Create new")` or `button:has-text("New API key")`.
- Create dialog label input: `input[placeholder*="Label" i]` or `input[placeholder*="Name" i]`.
- Create dialog confirm button: `button:has-text("Create")` inside the dialog.
- Revealed key element: the `lin_api_…` token appears in a `<code>` or `<input readonly>` next to a "Copy" button in the post-create dialog. Once the dialog closes, the key cannot be re-revealed — re-running mints a new one.
