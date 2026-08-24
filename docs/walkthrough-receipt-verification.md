# Walkthrough: receipt verification to first-use completion

What does the full proof path look like when you actually run it? This page
executes it end to end, entirely offline: generate a synthetic signed receipt
with the public client's example, verify it with the fail-closed verifier,
then feed the same receipt to the Weles CLI to complete the three-screen
first-use journey — including one deliberate failure. Every output below was
produced by these exact commands. A synthetic receipt proves nothing about a
workflow; it exists so you can watch verification succeed and fail before an
operated deployment issues real ones
(`weles-client/docs/examples/make-synthetic-receipt.mjs`).

## Prerequisites

- A built Weles checkout: `npm install && npm run build`, so `node
  dist/cli.js` works ([quick start](quick-start.md)). `npm install` also
  provides `@wisent-ai/weles-client`, which the CLI's `verify` action imports
  at runtime — it is a pinned GitHub dependency in `package.json`, not a
  vendored copy. If the import ever fails, an operator reinstalls
  dependencies rather than pointing at a local checkout.
- A `weles-client` checkout beside the Weles checkout (the two example
  scripts below are run from it by relative path).
- Node only. No deployment, no credentials, no network.

All commands run from the Weles checkout root.

## Step 1 — generate a synthetic signed receipt

The generator creates an Ed25519 key pair, signs the six workflow claims
(`taskId`, `organizationId`, `origin`, `action`, `outcome`,
`evidenceDigest`), and writes both the receipt and the caller-side key map.
The signed `outcome` is `completed` — the only outcome the journey will later
accept (`src/onboarding.ts`).

```bash
export TMP=$(mktemp -d)
node ../weles-client/docs/examples/make-synthetic-receipt.mjs "$TMP"
```

```json
{
  "wrote": ["receipt.json", "receipt-keys.json"],
  "dir": "/var/folders/.../tmp.o3SSwszhnK",
  "taskId": "1216819d-5a4f-4046-a068-88003fe61311"
}
```

`receipt.json` is the document a deployment would attach to a terminal
service response: `schema: weles.receipt.current`, the verification fields
`keyId`/`signature`/`signedPayload`, and displayed copies of every signed
claim ([receipts](receipts.md)). `receipt-keys.json` maps the key ID to the
PEM public key — in production the caller receives that map over a separately
authenticated channel; the receipt never supplies its own key.

## Step 2 — verify it offline with the public client

```bash
node ../weles-client/docs/examples/verify-receipt-offline.mjs \
  "$TMP/receipt.json" "$TMP/receipt-keys.json"
```

```json
{
  "verified": true,
  "claims": {
    "taskId": "1216819d-5a4f-4046-a068-88003fe61311",
    "organizationId": "ea3df632-e738-470b-84b7-f9c5547185c0",
    "origin": "https://example.com",
    "action": "example_check",
    "outcome": "completed",
    "evidenceDigest": "16198c79f4c65a8410a1eba8eee702a948f1161e1ebe114ce13fda98a2c27344",
    "keyId": "docs-demo-key"
  }
}
```

`verifyReceipt` checked schema, key resolution, the Ed25519 signature over
the exact `signedPayload` bytes, payload parse, and displayed-field equality
— in that order, each fail-closed (`weles-client/src/index.mjs`).

## Step 3 — walk the journey to the verification screen

The first-use journey has three required screens; the first two are
explanations, the third accepts only a verified receipt
(`src/onboarding/journeys/weles-first-use-2026-08-04.1.json`). Without
`STADO_INTEGRATION_API_URL` and `WELES_STADO_INTEGRATION_TOKEN` the CLI runs
against the bundled journey and reports `control_plane: "offline"`; progress
is durable per subject under `--state-dir` (`src/onboarding.ts`).

```bash
node dist/cli.js onboarding status --state-dir "$TMP/state" --subject walkthrough
```

```json
{
  "product_id": "weles",
  "journey_id": "first-use",
  "journey_version": "2026-08-04.1",
  "status": "in_progress",
  "attempt_id": "80f60ffd-3bfc-414c-9766-067425111dc3",
  "screen": {
    "id": "authorization-boundary",
    "title": "Confirm the authorization boundary",
    "actions": ["next"]
  },
  "control_plane": "offline"
}
```

(Screen `body` texts are trimmed here; the CLI prints them in full.) Advance
twice:

```bash
node dist/cli.js onboarding next --state-dir "$TMP/state" --subject walkthrough
node dist/cli.js onboarding next --state-dir "$TMP/state" --subject walkthrough
```

The first `next` lands on `host-execution`; the second lands on the terminal
screen:

```json
{
  "status": "in_progress",
  "screen": {
    "id": "receipt-verification",
    "title": "Verify the real workflow receipt",
    "actions": ["verify"]
  },
  "control_plane": "offline"
}
```

A third `next` would be refused — `the receipt-verification step requires a
signed service receipt; use onboarding verify` — and `verify` before this
screen is refused with `complete the authorization-boundary and
host-execution steps before verifying a receipt` (`src/onboarding.ts`).

## Step 4 — the failure case: unknown key ID

Rename the key ID in a copy of the key map so the receipt's `keyId`
(`docs-demo-key`) no longer resolves, then verify:

```bash
node -e "const fs=require('fs');const k=JSON.parse(fs.readFileSync(process.env.TMP+'/receipt-keys.json','utf8'));fs.writeFileSync(process.env.TMP+'/wrong-keys.json',JSON.stringify({'rotated-away-key':k['docs-demo-key']},null,2));"
node dist/cli.js onboarding verify --receipt "$TMP/receipt.json" \
  --keys "$TMP/wrong-keys.json" --state-dir "$TMP/state" --subject walkthrough
```

```text
weles: No trusted public key matches the receipt key identifier
```

Exit code 1. The key material is identical — only the identifier differs —
and verification still refuses: the caller's key map is the only trust
anchor, and an unresolved `keyId` is the `unknown-receipt-key` failure
(`weles-client/src/index.mjs`). The journey state is untouched.

## Step 5 — verify and complete

```bash
node dist/cli.js onboarding verify --receipt "$TMP/receipt.json" \
  --keys "$TMP/receipt-keys.json" --state-dir "$TMP/state" --subject walkthrough
```

```json
{
  "product_id": "weles",
  "journey_id": "first-use",
  "journey_version": "2026-08-04.1",
  "status": "completed",
  "attempt_id": "80f60ffd-3bfc-414c-9766-067425111dc3",
  "screen": {
    "id": "receipt-verification",
    "title": "Verify the real workflow receipt",
    "actions": []
  },
  "control_plane": "offline",
  "verified_receipt": {
    "task_id": "1216819d-5a4f-4046-a068-88003fe61311",
    "outcome": "completed",
    "evidence_digest": "16198c79f4c65a8410a1eba8eee702a948f1161e1ebe114ce13fda98a2c27344",
    "key_id": "docs-demo-key"
  }
}
```

`--receipt` accepts the bare receipt document (used here) or an envelope with
a `receipt` field — the CLI unwraps the envelope before verifying
(`src/cli.ts`). A later `onboarding status` shows `status: "completed"` with
no actions left; the `verified_receipt` block is printed by the `verify` call
itself.

## What just happened

The journey's terminal screen demands the fact
`authorized_browser_workflow_completed`, and the CLI asserts that fact only
after `@wisent-ai/weles-client` cryptographically verified the receipt, every
claim came back as a non-empty string, and the signed `outcome` was
`completed` — a non-completed outcome is refused with `verified receipt
outcome is not a completed Weles workflow: <outcome>` (`src/onboarding.ts`).
So first use completes on the same proof a caller uses to hold a deployment
accountable: one trusted key signed exactly these claims, binding task,
organization, origin, action, outcome, and evidence digest together
([receipts](receipts.md)). With a real deployment the only differences are
where the receipt comes from — the terminal response of a workflow admitted
through the authorization contract ([authorization](authorization.md)) — and
where the key map comes from: your own key distribution, never the receipt.
