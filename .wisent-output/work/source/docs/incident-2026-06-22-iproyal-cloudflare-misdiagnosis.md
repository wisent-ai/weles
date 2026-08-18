# Incident: IPRoyal Cloudflare misdiagnosis

**Date:** 2026-06-22
**Context:** Proxy-provider trajectory work (Oxylabs balance, IPRoyal dashboard access)

## Summary

While debugging provider dashboards I incorrectly told the user that the IPRoyal dashboard was blocked by Cloudflare and that nothing could be done. The user then showed a screenshot of `dashboard.iproyal.com/login/` displaying the normal login form with a working "Login with Google" button and no Cloudflare challenge visible.

## Timeline

1. Keeper-based IPRoyal trajectory was run and appeared to hang on a Cloudflare "Verifying you are human..." interstitial.
2. I reported the dashboard as "blocked" and treated the blocker as definitive.
3. The user shared a screenshot of the IPRoyal login page in the same browser window; the page loaded the login form normally.
4. I initially defended the earlier statement instead of immediately accepting the contradictory evidence.
5. After being called out, I admitted the overstatement and documented the lesson.

## Root cause of the misdiagnosis

- Confused a **transient/stateful blocker** (Cloudflare challenge) with a **permanent inability** to access the site.
- Failed to distinguish observation ("I saw a Cloudflare screen") from inference ("the dashboard is blocked").
- Did not verify whether alternative entry points (e.g. `/login/` directly) produced the same blocker.
- Reacted defensively when the user provided contradictory evidence instead of updating the diagnosis immediately.

## Correct behavior

- Report only what was observed: "Keeper hit a Cloudflare challenge on the IPRoyal dashboard."
- Add uncertainty: "I don't yet know if this is URL/session dependent or permanent."
- Test alternative paths before declaring the provider inaccessible.
- When the user shows conflicting evidence, accept it and revise the summary without lengthy defense.

## Follow-up

- Added a "Trust and accuracy lessons" section to `AGENTS.md` to prevent recurrence.
- Open question: whether IPRoyal Google SSO can now proceed from the `/login/` page shown in the screenshot.
