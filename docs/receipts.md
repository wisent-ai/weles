# Receipts

How does a caller prove what Weles did without trusting Weles' word for it?
With a signed receipt: the operated deployment closes a task's terminal
response with a document whose claims are bound by a signature the caller
verifies offline, against keys the caller owns. The verifier is the public
[`@wisent-ai/weles-client`](https://github.com/wisent-ai/weles-client), and it
fails closed.

## Who issues, who verifies

The split is deliberate and worth stating exactly. No code in this repository
constructs or signs a `weles.receipt.current` document; the tree carries the
schema names among its supported API schemas (`weles.receipt.v1` and
`weles.receipt.current` in `release/compatibility-policy.json`) and the
verification paths, but no signing key and no issuance path. Receipts are
issued by the operated deployment surface that answers `submit`, `get`, and
`cancel` — not by anything you can run from this checkout. Verification is
public, offline, and fail-closed: `verifyReceipt` in weles-client
(`src/index.mjs` of that repo) and its executor-side wrapper
`weles onboarding verify` (`src/onboarding.ts`).

## What is signed

The receipt document (`schema: weles.receipt.current`) carries three
verification fields and the displayed claims beside them:

| Field | Meaning |
|---|---|
| `keyId` | Names the trusted public key in the caller's key map |
| `signature` | Base64 signature over `signedPayload` |
| `signedPayload` | The exact JSON text of the claims that were signed |
| `taskId`, `organizationId`, `origin`, `action`, `outcome`, `evidenceDigest` | Displayed copies of the signed claims |

The signed payload binds the six claims together: which task, for which
organization, against which origin, doing which action, with which outcome,
over which evidence. `evidenceDigest` is a digest of the run's retained
evidence, so the receipt commits to the evidence without containing it; the
complete `recordings/<run_uuid>/` tree is mirrored to private Stado objects
and only canonical private locators are published
(`src/worker/upload-artifacts.ts`, [workflows](workflows.md)). First-use
receipts additionally carry signed `subject`, `audience`, and `product`
claims, required by weles-client's `verifyFirstReceipt`.

## What a verifier checks

`verifyReceipt(receipt, keys)` in weles-client (`src/index.mjs`) performs, in
order:

1. the receipt is an object and `schema` is exactly `weles.receipt.current` —
   anything else is `unsupported-receipt` ("The receipt schema is not
   supported");
2. `keyId`, `signature`, and `signedPayload` are non-empty strings — a missing
   one is `invalid-input` ("receipt.keyId must be a non-empty string", and
   likewise for the others);
3. `keyId` resolves in the caller-supplied key map (key ID → PEM public key);
   an unknown key is `unknown-receipt-key` ("No trusted public key matches the
   receipt key identifier") — the receipt never supplies its own verification
   key;
4. the signature verifies over the exact `signedPayload` bytes with Node's
   `crypto.verify`; failure is `invalid-receipt-signature` ("The receipt
   signature is invalid");
5. `signedPayload` parses as JSON — failure is `invalid-receipt-payload` ("The
   signed receipt payload is not JSON") — and the parsed claims must be an
   object;
6. every displayed field — `taskId`, `organizationId`, `origin`, `action`,
   `outcome`, `evidenceDigest` — must equal its signed claim; any difference
   is `receipt-claim-mismatch` ("A displayed receipt field differs from the
   signed claim").

Only then are the frozen claims returned. Every failure is a
`WelesClientError` with the stable `code` above. Verification proves that one
trusted key signed exactly this payload and that the displayed fields match
it; it deliberately does not check key revocation, certificate chains,
freshness, evidence availability, or target-side truth — those stay with the
caller (weles-client README).

The client verifies automatically: `submit`, `get`, and `cancel` each run
`verifyReceipt` on any `receipt` present in the response before returning it.
First-use verification is stricter still: `verifyFirstReceipt` also requires
the signed `subject`, `audience`, and `product` claims to match the caller,
failing with `receipt-subject-mismatch`, `receipt-audience-mismatch`, or
`receipt-product-mismatch`.

## Verifying locally

`weles onboarding verify` is the executor-side wrapper around the same
verifier:

```bash
weles onboarding verify --receipt <receipt.json> --keys <receipt-keys.json>
```

`--keys` is a non-empty JSON map of key IDs to PEM public keys; `--receipt`
accepts the receipt document or an envelope with a `receipt` field
(`src/cli.ts`). The wrapper requires every verified claim (`taskId`,
`organizationId`, `origin`, `action`, `outcome`, `evidenceDigest`, `keyId`) to
be a non-empty string — a gap is "verified receipt claim `<field>` is
missing" — and completes first use only when the signed `outcome` is
`completed` (`src/onboarding.ts`). Trusted keys must arrive through a
separately authenticated channel. An end-to-end local verification is walked
through in
[walkthrough-receipt-verification](walkthrough-receipt-verification.md);
verification failures are listed in the [runbook](runbook.md).

## Other receipts named "receipt"

Two adjacent mechanisms share the word but not the schema. Browser installs
write a `.weles-release` receipt recording the exact release URI, archive
SHA-256, and platform; the browser launches only when that file matches the
configured coordinate byte for byte (`src/session/find_browser.ts`). And
release promotion requires a signed Probierz evidence receipt covering the
candidate's contract runs before any ring activation (`scripts/release/activate.mjs`,
[releases](releases.md)). Neither is a workflow receipt; only
`weles.receipt.current` binds a task outcome.
