# Debug Strategy: Isolating Automation Detection

When an automated flow fails against a detection stack (Arkose, BotD, DataDome,
hCaptcha, etc.), blame is always between three things: **the IP, the browser,
or the behavior**. Speculating wastes days. This document is the decision tree
we walk to bisect which one is actually failing — each step eliminates exactly
one candidate.

The flow is strictly sequential: do not proceed to the next step until the
current step passes.

---

## Step 1 — Stock Chrome + Human

Run the target flow end to end in a fresh, unpatched Chrome on the same proxy /
exit IP the bot will use. Perform every action by hand.

- **If it fails:** The IP is burnt. Rotate to a fresh subnet / provider and
  repeat. No point in any other debugging — the detection stack has already
  decided against this identity before any code of ours runs.
- **If it passes:** The IP is clean. Lock the exact session + exit-IP combo;
  subsequent steps must reuse the same class of proxy so IP reputation is held
  constant as a variable.

## Step 2 — Weles + Human

Same flow, same proxy class, but now launch `weles` (our custom Chromium) and
drive it by hand — real keyboard and mouse, VNC or headed local, operator
controls every click and keystroke.

- **If it fails:** The browser is the problem. The fingerprint / TLS / API
  surface still leaks. Run `capture_fingerprint_local.mjs` against weles and
  `capture_fingerprint.mjs` against stock Chrome on the same hardware, diff
  the two JSON outputs, and fix the specific fields that differ. Do not move
  on until this step passes.
- **If it passes:** The browser is clean. Detection is in the **behavior** of
  the bot, not the bytes it sends.

## Step 3 — Weles + Mixed Actions

With browser and IP ruled out, the only remaining variable is the bot's
per-action behavior. Binary-search which specific step trips detection by
splitting the flow: a human performs some actions in the session, the bot
performs the rest. Two runs cover most flows:

1. **Bot up to step N, human past N.** If it passes, bot's early actions are
   fine; detection fires after step N.
2. **Human up to step N, bot past N.** If it fails, bot's late actions are the
   problem.

Halve N each iteration (form fill → captcha click → puzzle clicks → submit).
Once isolated, the failing action is the one to instrument and fix (native OS
events vs CDP, PointerEvent pressure/tilt, per-click idle jitter, etc.).

---

## Applying to GitHub Arkose (current open investigation)

- Step 1 status: **not run**. We have never confirmed a stock-Chrome signup on
  the Oxylabs Mobile IP class we are currently using. Without this baseline,
  every failure is ambiguous between "IP burnt" and "our code is wrong."
- Step 2 status: **provisionally passed** on 2026-04-18. A human-driven weles
  session through Oxylabs Mobile got exactly one Arkose puzzle and reached
  `/account_verifications`. Same browser binary we ship.
- Step 3 status: **open**. The bot run on 2026-04-19 got 22 puzzles with
  identical fingerprint and IP class. Detection is behavioral. Next action is
  to bisect which specific bot step flips the risk score — most likely the
  Create-account click or the puzzle-phase clicks, but untested.

Until Step 1 is rerun on a fresh IP, we cannot rule out that today's Oxylabs
Mobile pool has simply been burnt by yesterday's traffic.

---

## Reuse rules

- Do not write new capture / diff tooling. `scripts/debug/capture_fingerprint.mjs`
  (stock reference via Bright Data) and `scripts/debug/capture_fingerprint_local.mjs`
  (weles) share the probe in `src/diagnostics/fingerprint_probe.ts`. Diff the
  two JSON outputs.
- Human-driven runs capture to `recordings/behavior_*.jsonl` via the same
  `capture_fingerprint_local.mjs PROBE_WAIT=1` mode. Do not build a second
  recorder.
- For bot-behavior bisection, keep the bot in `scripts/trajectories/<platform>/`
  and gate specific steps behind env flags (e.g. `SKIP_CREATE_CLICK=1`) so the
  operator can take over mid-flow rather than forking the script.
