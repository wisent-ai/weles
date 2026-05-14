# weles/scripts/inspect — persistent-session interactive driving

A pair of helpers for **opening a weles browser once and driving it via repeated
single-action invocations** instead of writing a fresh `WSession.start → main →
s.close` trajectory for every iteration.

## When to use

Use this when:
- Exploring an unfamiliar provider's web UI
- Iterating on selectors for a flow with login, captcha, or rate-limit gates
  that you don't want to re-trigger on every attempt
- Discovering a provider's internal API by watching `performance.getEntriesByType('resource')`
  after a few clicks

Do NOT use this for production trajectories — those still belong in
`scripts/trajectories/<platform>/<action>.mjs` once the flow is understood.

## Why it exists

On 2026-05-08, the agent ran 35+ fresh-launch hyglobal trajectories that each
re-did Google SSO + email-form-fill + ToS modal + slide-captcha + Tencent
email rate-limit consumption. Zero deliverables. The agent then realized: the
right tool for exploring a flow is a persistent session, not a fire-and-forget
trajectory. This subsystem is the result.

The `pre_bash.sh` device hook now blocks 3+ identical trajectory invocations
without an intervening inspection action, specifically to force the agent
toward this pattern when iterating on an unfamiliar page.

## Usage

```bash
# Step 1: launch the persistent session (long-running)
node scripts/inspect/keep_session.mjs --url https://3d.hunyuanglobal.com/ --port 9223 --profile hyglobal

# Step 2 (in another shell or via background): drive single actions
node scripts/inspect/act.mjs dump                                  # writes outerHTML + JSON summary to .work/inspect/
node scripts/inspect/act.mjs click 'button:has-text("Send")'
node scripts/inspect/act.mjs fill 'input[type="email"]' 'me@example.com'
node scripts/inspect/act.mjs nav https://other.example.com
node scripts/inspect/act.mjs screenshot
node scripts/inspect/act.mjs eval 'document.title'
node scripts/inspect/act.mjs url
node scripts/inspect/act.mjs api POST /api/path '{"key":"value"}'
node scripts/inspect/act.mjs download https://cdn.example.com/file.glb /path/to/save.glb
```

## Conventions

- **CDP port**: default 9223. Override with `--port N` on both keep_session and act.
- **Profile dir**: `~/.weles/inspect_profiles/<name>/` so different providers
  can have their own cookie state without colliding.
- **Cookie jar inject**: pass `--jar /path/to/cookies.json` to keep_session
  to pre-load a cookie set on first launch.
- **Output dir**: act.mjs writes to `.work/inspect/` in the cwd —
  `dump_<ts>.html`, `summary_<ts>.json`, `shot_<ts>.png`, `api_<ts>.json`.

## Inspection actions that reset the rerun counter

The `pre_bash.sh` hook recognizes these as inspection (counter resets,
trajectory re-runs unblocked):

- `ffmpeg ... .webm`
- Any path matching `.work/<label>/frame_*.png`
- Redirect of `outerHTML` output to a file under `.work/`
- Write of `.work/<label>/inspection.md`
- `inspect/act.mjs dump|screenshot|eval|url`

## Original location

Earlier copies of this pattern lived at `scripts/trajectories/tencent/keeper/`
during the Tencent HY 3D Global flow on 2026-05-08. Those are obsolete; use
the canonical files here.
